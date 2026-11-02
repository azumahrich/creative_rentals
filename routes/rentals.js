const router = require('express').Router();
const db     = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { protectClient } = require('../middleware/privacy');
const { availabilityFor, TODAY } = require('./availability');

router.use(requireAuth);

/*
 * Rental life-cycle
 *   booked   → made for a future date. Holds the dates but does NOT take stock yet.
 *   active   → equipment is with the client (picked up). Stock is taken out.
 *   overdue  → active and not returned by 5:00 PM on the return date.
 *   returned → back in the shop. Stock is put back.
 *   cancelled→ a booking that won't go ahead (no-show / client cancelled).
 *
 * Who can do what: staff create rentals/bookings and mark "Picked up";
 * admins also mark Returned, cancel bookings and delete rentals.
 */

// ─── Helpers ─────────────────────────────────────────────────────────────────
async function enrichRental(row, client) {
  const q = client || db;
  const { rows: items } = await q.query(
    `SELECT re.*, e.name, e.serial, e.category,
            (p.equipment_id IS NOT NULL) AS has_photo,
            COALESCE(FLOOR(EXTRACT(EPOCH FROM p.updated_at))::bigint, 0) AS photo_v
     FROM rental_equipment re
     JOIN equipment e ON e.id = re.equipment_id
     LEFT JOIN equipment_photos p ON p.equipment_id = e.id
     WHERE re.rental_id = $1`, [row.id]
  );
  const { rows: payments } = await q.query(
    'SELECT * FROM payments WHERE rental_id=$1 ORDER BY paid_at', [row.id]
  );
  return { ...row, equipment: items, payments };
}

const ref = id => '#R-' + String(id).padStart(4, '0');
const fmtDay = d => new Date(d + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

// Rentals start at 8:00 AM on the rental date and end at 5:00 PM on the return date
// (same day by default). Charged per 8am–5pm day.
const RENTAL_START = '08:00', RENTAL_END = '17:00';

// Active rentals not returned by 5:00 PM (Ghana time) on their date become overdue
const OVERDUE_SQL = `UPDATE rentals SET status='overdue'
  WHERE status='active' AND (end_date + TIME '17:00') < (NOW() AT TIME ZONE 'Africa/Accra')`;
const markOverdue = () => db.query(OVERDUE_SQL);

// Take / put back physical stock for a rental's items (inside a transaction)
async function takeStock(c, rentalId) {
  const { rows: items } = await c.query(
    `SELECT re.equipment_id, SUM(re.qty)::int AS qty, e.name
     FROM rental_equipment re JOIN equipment e ON e.id = re.equipment_id
     WHERE re.rental_id=$1 GROUP BY re.equipment_id, e.name`, [rentalId]);
  for (const it of items) {
    const { rowCount } = await c.query(
      'UPDATE equipment SET available = available - $1 WHERE id=$2 AND available >= $1', [it.qty, it.equipment_id]);
    if (!rowCount) {
      const { rows: [e] } = await c.query('SELECT available FROM equipment WHERE id=$1', [it.equipment_id]);
      const { rows: out } = await c.query(
        `SELECT r.id FROM rentals r JOIN rental_equipment re ON re.rental_id=r.id
         WHERE re.equipment_id=$1 AND r.status IN ('active','overdue') ORDER BY r.end_date LIMIT 3`, [it.equipment_id]);
      const who = out.length ? ` — still out on ${out.map(o => ref(o.id)).join(', ')}` : '';
      const err = new Error(`Only ${e ? e.available : 0} × ${it.name} in the shop right now${who}`);
      err.status = 409; throw err;
    }
  }
}
async function putBackStock(c, rentalId) {
  await c.query(
    `UPDATE equipment e SET available = LEAST(e.total, e.available + x.qty)
     FROM (SELECT equipment_id, SUM(qty)::int AS qty FROM rental_equipment WHERE rental_id=$1 GROUP BY equipment_id) x
     WHERE e.id = x.equipment_id`, [rentalId]);
}

// GET /api/rentals/availability?from=YYYY-MM-DD&to=YYYY-MM-DD
// How many of each item are free for those dates (used by the New Rental screen)
router.get('/availability', async (req, res) => {
  const isDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
  const { from, to } = req.query;
  if (!isDate(from) || !isDate(to) || to < from) return res.status(400).json({ error: 'Valid from/to dates required' });
  try {
    const { map, today } = await availabilityFor(db, from, to);
    res.json({ today, items: Object.fromEntries([...map].map(([id, a]) => [id, a.free])) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/rentals
router.get('/', async (req, res) => {
  await markOverdue().catch(() => {});
  const { status, client_id } = req.query;
  let sql  = 'SELECT r.*, c.name AS client_name, c.phone AS client_phone FROM rentals r JOIN clients c ON c.id = r.client_id';
  const p  = [];
  const w  = [];
  if (status)    { w.push(`r.status=$${p.push(status)}`); }
  if (client_id) { w.push(`r.client_id=$${p.push(client_id)}`); }
  if (w.length)  sql += ' WHERE ' + w.join(' AND ');
  sql += status === 'booked' ? ' ORDER BY r.start_date, r.id' : ' ORDER BY r.created_at DESC';

  try {
    const { rows } = await db.query(sql, p);
    const result = await Promise.all(rows.map(r => enrichRental(r)));
    res.json(result.map(r => protectClient(r, req.user)));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/rentals/:id
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT r.*, c.name AS client_name, c.phone AS client_phone, c.email AS client_email,
              c.ghana_card, c.id_number
       FROM rentals r JOIN clients c ON c.id = r.client_id
       WHERE r.id=$1`, [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Rental not found' });
    res.json(protectClient(await enrichRental(rows[0]), req.user));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/rentals — a rental starting today is handed over now (active);
// one starting on a later date is saved as a booking.
router.post('/', async (req, res) => {
  const { client_id, equipment, notes } = req.body;
  const rental_date = req.body.rental_date || req.body.start_date;
  const return_date = req.body.return_date || req.body.end_date || rental_date;
  if (!client_id || !rental_date || !equipment || !equipment.length)
    return res.status(400).json({ error: 'client_id, rental_date and equipment required' });
  const isDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
  if (!isDate(rental_date) || !isDate(return_date))
    return res.status(400).json({ error: 'Dates must be YYYY-MM-DD' });
  if (return_date < rental_date)
    return res.status(400).json({ error: 'Return date cannot be before the rental date' });
  const start_date = rental_date, end_date = return_date;
  const days = Math.round((Date.parse(end_date) - Date.parse(start_date)) / 86400000) + 1;

  // Add up quantities per item (two rows can pick the same item)
  const wanted = new Map();
  for (const it of equipment) {
    const id = parseInt(it.equipment_id), qty = Math.max(1, parseInt(it.qty) || 1);
    if (!id) return res.status(400).json({ error: 'Invalid equipment item' });
    wanted.set(id, (wanted.get(id) || 0) + qty);
  }

  const pgClient = await db.connect();
  try {
    await pgClient.query('BEGIN');
    // Lock these items so two people can't book the last unit at the same moment
    await pgClient.query('SELECT id FROM equipment WHERE id = ANY($1::int[]) FOR UPDATE', [[...wanted.keys()]]);

    const { rows: [{ today }] } = await pgClient.query(`SELECT ${TODAY}::text AS today`);
    if (end_date < today) { await pgClient.query('ROLLBACK'); return res.status(400).json({ error: 'The return date is in the past' }); }
    const status = start_date > today ? 'booked' : 'active';

    // Date-aware check against other bookings and rentals
    const { map } = await availabilityFor(pgClient, start_date, end_date);
    for (const [id, qty] of wanted) {
      const a = map.get(id);
      if (!a) { await pgClient.query('ROLLBACK'); return res.status(404).json({ error: 'Equipment not found' }); }
      if (qty > a.free) {
        const clash = a.rental_ids && a.rental_ids.length
          ? ` — already booked/out on ${fmtDay(a.busiest_day)} (${a.rental_ids.slice(0, 3).map(ref).join(', ')})` : '';
        await pgClient.query('ROLLBACK');
        return res.status(409).json({ error: `Only ${a.free} × ${a.name} free for these dates${clash}` });
      }
    }

    let subtotal = 0, deposit = 0;
    for (const item of equipment) {
      subtotal += (item.unit_price  || 0) * (item.qty || 1) * (days || 1);
      deposit  += (item.unit_deposit|| 0) * (item.qty || 1);
    }

    const { rows: [rental] } = await pgClient.query(
      `INSERT INTO rentals (client_id, start_date, end_date, days, status, subtotal, deposit_amt, pickup_time, return_time, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [client_id, start_date, end_date, days, status, subtotal, deposit, RENTAL_START, RENTAL_END, notes||null]
    );
    for (const item of equipment) {
      await pgClient.query(
        `INSERT INTO rental_equipment (rental_id, equipment_id, qty, unit_price, unit_deposit)
         VALUES ($1,$2,$3,$4,$5)`,
        [rental.id, item.equipment_id, item.qty||1, item.unit_price||0, item.unit_deposit||0]
      );
    }
    // Handed over today → take the stock now. Bookings take stock at pickup.
    if (status === 'active') await takeStock(pgClient, rental.id);

    await pgClient.query('COMMIT');
    res.status(201).json(await enrichRental(rental));
  } catch (err) {
    await pgClient.query('ROLLBACK');
    res.status(err.status || 500).json({ error: err.message });
  } finally {
    pgClient.release();
  }
});

// POST /api/rentals/:id/pickup — client collects a booking (staff & admins)
router.post('/:id/pickup', async (req, res) => {
  const pgClient = await db.connect();
  try {
    await pgClient.query('BEGIN');
    const { rows: [r] } = await pgClient.query('SELECT * FROM rentals WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!r) { await pgClient.query('ROLLBACK'); return res.status(404).json({ error: 'Rental not found' }); }
    if (r.status !== 'booked') { await pgClient.query('ROLLBACK'); return res.status(400).json({ error: `${ref(r.id)} is not a booking (it is ${r.status})` }); }
    const { rows: [{ today }] } = await pgClient.query(`SELECT ${TODAY}::text AS today`);
    if (r.start_date > today) {
      await pgClient.query('ROLLBACK');
      return res.status(400).json({ error: `${ref(r.id)} is booked for ${fmtDay(r.start_date)}. It can be picked up from that day.` });
    }
    if (r.end_date < today) {
      await pgClient.query('ROLLBACK');
      return res.status(400).json({ error: `${ref(r.id)}'s booking dates have passed. Ask an admin to cancel it and make a new rental.` });
    }
    await takeStock(pgClient, r.id);
    const { rows: [u] } = await pgClient.query("UPDATE rentals SET status='active' WHERE id=$1 RETURNING *", [r.id]);
    await pgClient.query('COMMIT');
    res.json(await enrichRental(u));
  } catch (err) {
    await pgClient.query('ROLLBACK');
    res.status(err.status || 500).json({ error: err.message });
  } finally {
    pgClient.release();
  }
});

// POST /api/rentals/:id/cancel — cancel a booking (admins)
router.post('/:id/cancel', requireAdmin, async (req, res) => {
  try {
    const { rows } = await db.query(
      "UPDATE rentals SET status='cancelled' WHERE id=$1 AND status='booked' RETURNING *", [req.params.id]);
    if (!rows.length) return res.status(400).json({ error: 'Only bookings that have not been picked up can be cancelled' });
    res.json(await enrichRental(rows[0]));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/rentals/:id  (admins) — mark returned, or edit notes
router.patch('/:id', requireAdmin, async (req, res) => {
  const { status, notes } = req.body;
  if (status !== undefined && status !== 'returned')
    return res.status(400).json({ error: 'Use Picked up / Cancel booking for other status changes' });
  const pgClient = await db.connect();
  try {
    await pgClient.query('BEGIN');
    const { rows: [r] } = await pgClient.query('SELECT * FROM rentals WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!r) { await pgClient.query('ROLLBACK'); return res.status(404).json({ error: 'Rental not found' }); }
    if (status === 'returned') {
      if (!['active','overdue'].includes(r.status)) {
        await pgClient.query('ROLLBACK');
        return res.status(400).json({ error: r.status === 'returned' ? 'Already marked returned' : `${ref(r.id)} was never picked up` });
      }
      await putBackStock(pgClient, r.id);
      await pgClient.query("UPDATE rentals SET status='returned' WHERE id=$1", [r.id]);
    }
    if (notes !== undefined) await pgClient.query('UPDATE rentals SET notes=$1 WHERE id=$2', [notes, r.id]);
    const { rows: [u] } = await pgClient.query('SELECT * FROM rentals WHERE id=$1', [r.id]);
    await pgClient.query('COMMIT');
    res.json(await enrichRental(u));
  } catch (err) {
    await pgClient.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    pgClient.release();
  }
});

// DELETE /api/rentals/:id  (admins)
router.delete('/:id', requireAdmin, async (req, res) => {
  const pgClient = await db.connect();
  try {
    await pgClient.query('BEGIN');
    const { rows } = await pgClient.query('SELECT * FROM rentals WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!rows.length) { await pgClient.query('ROLLBACK'); return res.status(404).json({ error: 'Rental not found' }); }
    // Only equipment that is actually out goes back into stock
    if (['active','overdue'].includes(rows[0].status)) await putBackStock(pgClient, rows[0].id);
    await pgClient.query('DELETE FROM rentals WHERE id=$1', [req.params.id]);
    await pgClient.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await pgClient.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    pgClient.release();
  }
});

router.markOverdue = markOverdue;
router.OVERDUE_SQL = OVERDUE_SQL;
module.exports = router;
