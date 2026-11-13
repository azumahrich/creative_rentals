const router = require('express').Router();
// IDs in the address must be whole numbers (anything else is simply 'not found')
router.param('id', (req, res, next, id) => /^\d{1,9}$/.test(id) ? next() : res.status(404).json({ error: 'Not found' }));
const db     = require('../db');
const { requireAuth, requireAdmin, requireSuperAdmin } = require('../middleware/auth');
const { protectClient } = require('../middleware/privacy');
const { availabilityFor, TODAY } = require('./availability');
const { note, money } = require('../middleware/activity');
const { getRules, discountFor } = require('../middleware/pricing');

// One-line description of a rental for the activity log
async function describe(q, rentalId) {
  const { rows: [r] } = await q.query(
    `SELECT r.id, r.client_id, r.start_date, r.end_date, r.pickup_time, r.return_time, r.days, r.status, r.subtotal, r.deposit_amt, r.total_paid, r.discount_pct, r.discount_amt, c.name AS client,
            (SELECT string_agg(CASE WHEN re.qty > 1 THEN re.qty || ' × ' || e.name ELSE e.name END, ', ')
               FROM rental_equipment re JOIN equipment e ON e.id = re.equipment_id WHERE re.rental_id = r.id) AS items
     FROM rentals r JOIN clients c ON c.id = r.client_id WHERE r.id=$1`, [rentalId]);
  if (!r) return { text: '#R-' + String(rentalId).padStart(4, '0'), client_id: null };
  const t = x => /^\d{1,2}:\d{2}$/.test(x || '') ? hhmm(x) : (x || '');
  const dates = r.start_date === r.end_date ? `${r.start_date} ${t(r.pickup_time)}–${t(r.return_time)}`
                                            : `${r.start_date} ${t(r.pickup_time)} → ${r.end_date} ${t(r.return_time)}`;
  return { r, client_id: r.client_id,
    text: `#R-${String(r.id).padStart(4,'0')} for ${r.client} — ${r.items || 'no items'}, ${dates}, ${money(r.subtotal)}${+r.discount_amt ? ` (after ${+r.discount_pct}% discount of ${money(r.discount_amt)})` : ''} + deposit ${money(r.deposit_amt)}` };
}

router.use(requireAuth);

/*
 * Rental life-cycle
 *   booked   → made for a future date. Holds the dates but does NOT take stock yet.
 *   active   → equipment is with the client (picked up). Stock is taken out.
 *   overdue  → active and not returned by its return time (7:00 PM) on the return date.
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

// Pickup time is chosen when the rental is made (default 8:00 AM, any half hour 6:00 AM – 6:30 PM).
// Return is by 7:00 PM on the return date (same day by default). Charged per day.
const RENTAL_START = '08:00', RENTAL_END = '19:00';
const PICKUP_TIMES = [];
for (let m = 6 * 60; m < 19 * 60; m += 30) PICKUP_TIMES.push(String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'));
const hhmm = t => { const [h, m] = t.split(':').map(Number); return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };

// Active rentals not returned by their return time (Ghana time) on the return date become overdue.
// Each rental keeps the return time it was made with (rentals made before this change: 5:00 PM).
const OVERDUE_SQL = `UPDATE rentals SET status='overdue'
  WHERE status='active' AND (end_date + CASE WHEN return_time ~ '^\\s*\\d{1,2}:\\d{2}' THEN return_time::time ELSE TIME '19:00' END)
        < (NOW() AT TIME ZONE 'Africa/Accra')`;
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

// GET /api/rentals/discount-rules — so the New Rental screen can show the discount
router.get('/discount-rules', async (req, res) => {
  try { res.json(await getRules(db)); } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/rentals/availability?from=YYYY-MM-DD&to=YYYY-MM-DD
// How many of each item are free for those dates (used by the New Rental screen)
router.get('/availability', async (req, res) => {
  const isDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
  const { from, to } = req.query;
  if (!isDate(from) || !isDate(to) || to < from) return res.status(400).json({ error: 'Valid from/to dates required' });
  const exclude = /^\d+$/.test(req.query.exclude || '') ? +req.query.exclude : null;     // editing a booking: don't count its own items
  try {
    const { map, today } = await availabilityFor(db, from, to, exclude);
    res.json({ today, items: Object.fromEntries([...map].map(([id, a]) => [id, a.free])) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/rentals
router.get('/', async (req, res) => {
  await markOverdue().catch(() => {});
  const { status, client_id } = req.query;
  let sql  = `SELECT r.*, c.name AS client_name, c.phone AS client_phone,
                     ch.id AS change_id, ch.requested_by AS change_by, ch.requested_by_name AS change_by_name,
                     ch.reason AS change_reason, ch.summary AS change_summary
              FROM rentals r JOIN clients c ON c.id = r.client_id
              LEFT JOIN rental_changes ch ON ch.rental_id = r.id AND ch.status = 'pending'`;
  const p  = [];
  const w  = [];
  if (status)    { w.push(`r.status=$${p.push(status)}`); }
  if (client_id) { w.push(`r.client_id=$${p.push(client_id)}`); }
  if (w.length)  sql += ' WHERE ' + w.join(' AND ');
  sql += status === 'booked' ? ' ORDER BY r.start_date, r.id' : ' ORDER BY r.created_at DESC';

  try {
    const { rows } = await db.query(sql, p);
    // Load every rental's items and payments in two queries (not two per rental — that got slow as rentals grew)
    const ids = rows.map(r => r.id);
    const [{ rows: items }, { rows: pays }] = ids.length ? await Promise.all([
      db.query(`SELECT re.*, e.name, e.serial, e.category,
                       (p.equipment_id IS NOT NULL) AS has_photo,
                       COALESCE(FLOOR(EXTRACT(EPOCH FROM p.updated_at))::bigint, 0) AS photo_v
                FROM rental_equipment re JOIN equipment e ON e.id = re.equipment_id
                LEFT JOIN equipment_photos p ON p.equipment_id = e.id
                WHERE re.rental_id = ANY($1::int[]) ORDER BY re.id`, [ids]),
      db.query('SELECT * FROM payments WHERE rental_id = ANY($1::int[]) ORDER BY paid_at', [ids])]) : [{ rows: [] }, { rows: [] }];
    const group = list => list.reduce((m, x) => ((m[x.rental_id] = m[x.rental_id] || []).push(x), m), {});
    const byItem = group(items), byPay = group(pays);
    res.json(rows.map(r => protectClient({ ...r, equipment: byItem[r.id] || [], payments: byPay[r.id] || [] }, req.user)));
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
  const pickup_time = req.body.pickup_time || RENTAL_START;
  if (!PICKUP_TIMES.includes(pickup_time))
    return res.status(400).json({ error: 'Choose a pickup time between 6:00 AM and 6:30 PM' });
  const days = Math.round((Date.parse(end_date) - Date.parse(start_date)) / 86400000) + 1;

  const request_id = String(req.body.request_id || '').slice(0, 80) || null;
  if (request_id) {
    const { rows: [dup] } = await db.query('SELECT * FROM rentals WHERE request_id=$1', [request_id]);
    if (dup) return res.status(200).json({ ...(await enrichRental(dup)), duplicate: true });
  }

  // Add up quantities per item (two rows can pick the same item); check prices are sensible
  const wanted = new Map();
  for (const it of equipment) {
    const id = parseInt(it.equipment_id), qty = parseInt(it.qty) || 1;
    if (!id) return res.status(400).json({ error: 'Invalid equipment item' });
    if (qty < 1 || qty > 1000) return res.status(400).json({ error: 'Quantity must be at least 1' });
    if (!(+it.unit_price >= 0) || !(+(it.unit_deposit || 0) >= 0))
      return res.status(400).json({ error: 'Rates and deposits cannot be negative' });
    it.qty = qty; it.unit_price = +it.unit_price || 0; it.unit_deposit = +it.unit_deposit || 0;
    wanted.set(id, (wanted.get(id) || 0) + qty);
  }

  // Clients must have a Ghana Card and phone number on file before they can rent
  const { rows: [cl] } = await db.query('SELECT name, phone, ghana_card FROM clients WHERE id=$1', [client_id]);
  if (!cl) return res.status(404).json({ error: 'Client not found' });
  const missing = [!cl.ghana_card && 'Ghana Card number', !cl.phone && 'phone number'].filter(Boolean);
  if (missing.length)
    return res.status(400).json({ error: `${cl.name} has no ${missing.join(' or ')} on file. An admin must add it before renting.` });

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

    let gross = 0, deposit = 0;
    for (const item of equipment) {
      gross   += (item.unit_price  || 0) * (item.qty || 1) * (days || 1);
      deposit += (item.unit_deposit|| 0) * (item.qty || 1);
    }
    // Loyalty discount on the rental charge (not the deposit)
    const disc = discountFor(gross, await getRules(pgClient));

    const { rows: [rental] } = await pgClient.query(
      `INSERT INTO rentals (client_id, start_date, end_date, days, status, subtotal, gross_amount, discount_pct, discount_amt,
                            deposit_amt, pickup_time, return_time, notes, request_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [client_id, start_date, end_date, days, status, disc.net, disc.gross, disc.pct, disc.amount,
       deposit, pickup_time, RENTAL_END, notes||null, request_id]
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

    const d = await describe(pgClient, rental.id);
    await pgClient.query('COMMIT');
    note(res, { action: status === 'booked' ? 'booking_create' : 'rental_create', entity: 'rental', entity_id: rental.id, client_id: d.client_id,
      summary: `${status === 'booked' ? 'Booked' : 'Created rental'} ${d.text}` });
    res.status(201).json(await enrichRental(rental));
  } catch (err) {
    await pgClient.query('ROLLBACK');
    if (err.code === '23505' && request_id) {
      const { rows: [dup] } = await db.query('SELECT * FROM rentals WHERE request_id=$1', [request_id]);
      if (dup) return res.status(200).json({ ...(await enrichRental(dup)), duplicate: true });
    }
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
    await closePendingChange(pgClient, r.id, 'Booking was picked up before the change was approved');
    const d = await describe(pgClient, r.id);
    await pgClient.query('COMMIT');
    note(res, { action: 'rental_pickup', entity: 'rental', entity_id: r.id, client_id: d.client_id, summary: `Handed over (picked up) ${d.text}` });
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
    await closePendingChange(db, rows[0].id, 'Booking was cancelled');
    const d = await describe(db, rows[0].id);
    note(res, { action: 'booking_cancel', entity: 'rental', entity_id: rows[0].id, client_id: d.client_id, summary: `Cancelled booking ${d.text}` });
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
      const d = await describe(pgClient, r.id);
      note(res, { action: 'rental_return', entity: 'rental', entity_id: r.id, client_id: d.client_id,
        summary: `Marked returned ${d.text}${r.status === 'overdue' ? ' (was overdue)' : ''}` });
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
// ─── Permanent delete: admins ask, only the Super Admin approves ──────────────
// POST /api/rentals/:id/delete-request { reason } — admin asks for a permanent delete
router.post('/:id/delete-request', requireAdmin, async (req, res) => {
  const reason = String((req.body || {}).reason || '').trim();
  if (reason.length < 5) return res.status(400).json({ error: 'Say why this rental should be deleted' });
  try {
    const { rows: [r] } = await db.query('SELECT id, status, delete_requested_at FROM rentals WHERE id=$1', [req.params.id]);
    if (!r) return res.status(404).json({ error: 'Rental not found' });
    if (r.delete_requested_at) return res.status(400).json({ error: `Deleting ${ref(r.id)} has already been requested — waiting for the Super Admin` });
    await db.query(`UPDATE rentals SET delete_requested_at=NOW(), delete_requested_by=$1, delete_requested_by_name=$2, delete_reason=$3 WHERE id=$4`,
      [req.user.id, req.user.name, reason.slice(0, 500), r.id]);
    const d = await describe(db, r.id);
    note(res, { action: 'rental_delete_request', entity: 'rental', entity_id: r.id, client_id: d.client_id,
      summary: `Asked the Super Admin to permanently delete ${d.text} — reason: ${reason}` });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/rentals/:id/delete-request/cancel { note? } — Super Admin rejects, or the person who asked withdraws
router.post('/:id/delete-request/cancel', requireAdmin, async (req, res) => {
  try {
    const { rows: [r] } = await db.query('SELECT id, delete_requested_at, delete_requested_by, delete_requested_by_name, delete_reason FROM rentals WHERE id=$1', [req.params.id]);
    if (!r || !r.delete_requested_at) return res.status(404).json({ error: 'There is no delete request for this rental' });
    const isSuper = req.user.role === 'superadmin';
    if (!isSuper && r.delete_requested_by !== req.user.id)
      return res.status(403).json({ error: 'Only the Super Admin or the person who asked can cancel this request' });
    await db.query(`UPDATE rentals SET delete_requested_at=NULL, delete_requested_by=NULL, delete_requested_by_name=NULL, delete_reason=NULL WHERE id=$1`, [r.id]);
    const d = await describe(db, r.id);
    const why = String((req.body || {}).note || '').trim();
    note(res, { action: isSuper && r.delete_requested_by !== req.user.id ? 'rental_delete_reject' : 'rental_delete_withdraw',
      entity: 'rental', entity_id: r.id, client_id: d.client_id,
      summary: isSuper && r.delete_requested_by !== req.user.id
        ? `Rejected ${r.delete_requested_by_name}'s request to delete ${d.text}${why ? ' — ' + why : ''}`
        : `Withdrew the request to delete ${d.text}` });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/rentals/:id — permanent delete, Super Admin only (approving a request, or directly)
router.delete('/:id', requireSuperAdmin, async (req, res) => {
  const pgClient = await db.connect();
  try {
    await pgClient.query('BEGIN');
    const { rows } = await pgClient.query('SELECT * FROM rentals WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!rows.length) { await pgClient.query('ROLLBACK'); return res.status(404).json({ error: 'Rental not found' }); }
    // Only equipment that is actually out goes back into stock
    if (['active','overdue'].includes(rows[0].status)) await putBackStock(pgClient, rows[0].id);
    const d = await describe(pgClient, rows[0].id);
    const asked = rows[0].delete_requested_at ? ` — approved request from ${rows[0].delete_requested_by_name} (reason: ${rows[0].delete_reason})` : '';
    note(res, { action: 'rental_delete', entity: 'rental', entity_id: rows[0].id, client_id: d.client_id,
      changes: [{ field: 'Rental', from: `${rows[0].status}, paid ${money(rows[0].total_paid)}`, to: '(deleted with its payments)' }],
      summary: `Permanently deleted rental ${d.text} (status ${rows[0].status}, paid ${money(rows[0].total_paid)})${asked}` });
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
// POST /api/rentals/:id/email { to? } — email the invoice / booking confirmation (anyone signed in)
router.post('/:id/email', async (req, res) => {
  const email = require('../lib/email');
  const { loadRental } = require('../lib/scheduler');
  try {
    const r = await loadRental(req.params.id);
    if (!r) return res.status(404).json({ error: 'Rental not found' });
    const typed = String((req.body || {}).to || '').trim();
    const to = typed || (r.client_email || '').trim();
    if (!to) return res.status(400).json({ error: `${r.client_name} has no email address on file. Type one in to send it.` });
    if (!email.isEmail(to)) return res.status(400).json({ error: 'That email address is not valid' });
    const m = email.invoiceEmail(r);
    const sent = await email.send({ ...m, to, kind: 'invoice', rental_id: r.id, client_id: r.client_id, user_id: req.user.id });
    if (!sent.ok) return res.status(400).json({ error: sent.error });
    const shown = req.user.role === 'staff' && !typed ? 'the client\'s email on file' : to;
    note(res, { action: 'invoice_email', entity: 'rental', entity_id: r.id, client_id: r.client_id,
      summary: `Emailed ${r.status === 'booked' ? 'booking confirmation' : 'invoice'} ${ref(r.id)} to ${r.client_name} (${to})` });
    res.json({ ok: true, to: shown });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/rentals/:id/emails — emails already sent for this rental
router.get('/:id/emails', async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT id, at, kind, status, error FROM email_log WHERE rental_id=$1 ORDER BY id DESC LIMIT 20', [req.params.id]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══ Editing a booking — Super Admin approval ═════════════════════════════════
// Staff/admins propose a change to a booking (not yet picked up). It waits until the Super Admin
// approves it. The Super Admin's own edits apply at once. Availability is checked when the change is
// asked for AND again at approval, prices/discount are worked out again, and payments stay as they are.
const httpErr = (status, message) => Object.assign(new Error(message), { status });

// Check a proposed booking and work out its totals. Throws httpErr on any problem.
async function planBooking(q, rental, body) {
  const isDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
  const client_id = parseInt(body.client_id || rental.client_id);
  const start_date = body.rental_date || rental.start_date;
  const end_date   = body.return_date || start_date;
  const pickup_time = body.pickup_time || rental.pickup_time || RENTAL_START;
  const notes = body.notes === undefined ? rental.notes : (String(body.notes || '').trim() || null);
  if (!isDate(start_date) || !isDate(end_date)) throw httpErr(400, 'Dates must be YYYY-MM-DD');
  if (end_date < start_date) throw httpErr(400, 'Return date cannot be before the rental date');
  if (!PICKUP_TIMES.includes(pickup_time)) throw httpErr(400, 'Choose a pickup time between 6:00 AM and 6:30 PM');
  const { rows: [{ today }] } = await q.query(`SELECT ${TODAY}::text AS today`);
  if (start_date < today) throw httpErr(400, 'A booking cannot be moved to a date in the past');
  const items = Array.isArray(body.equipment) ? body.equipment : [];
  if (!items.length) throw httpErr(400, 'A booking needs at least one item');

  const wanted = new Map(), clean = [];
  for (const it of items) {
    const id = parseInt(it.equipment_id), qty = parseInt(it.qty) || 1;
    if (!id) throw httpErr(400, 'Invalid equipment item');
    if (qty < 1 || qty > 1000) throw httpErr(400, 'Quantity must be at least 1');
    if (!(+it.unit_price >= 0) || !(+(it.unit_deposit || 0) >= 0)) throw httpErr(400, 'Rates and deposits cannot be negative');
    const row = { equipment_id: id, qty, unit_price: +it.unit_price || 0, unit_deposit: +it.unit_deposit || 0 };
    const same = clean.find(x => x.equipment_id === id && x.unit_price === row.unit_price && x.unit_deposit === row.unit_deposit);
    if (same) same.qty += qty; else clean.push(row);           // the same item picked twice → one line, qty added up
    wanted.set(id, (wanted.get(id) || 0) + qty);
  }
  const { rows: [cl] } = await q.query('SELECT name, phone, ghana_card FROM clients WHERE id=$1', [client_id]);
  if (!cl) throw httpErr(404, 'Client not found');
  if (!cl.ghana_card || !cl.phone) throw httpErr(400, `${cl.name} has no Ghana Card number or phone on file. An admin must add it first.`);

  // Free on the new dates — not counting this booking's own items
  const { map } = await availabilityFor(q, start_date, end_date, rental.id);
  for (const [id, qty] of wanted) {
    const a = map.get(id);
    if (!a) throw httpErr(404, 'Equipment not found');
    if (qty > a.free) {
      const clash = a.rental_ids && a.rental_ids.length
        ? ` — already booked/out on ${fmtDay(a.busiest_day)} (${a.rental_ids.slice(0, 3).map(ref).join(', ')})` : '';
      throw httpErr(409, `Only ${a.free} × ${a.name} free for these dates${clash}`);
    }
  }
  const days = Math.round((Date.parse(end_date) - Date.parse(start_date)) / 86400000) + 1;
  let gross = 0, deposit = 0;
  for (const it of clean) { gross += it.unit_price * it.qty * days; deposit += it.unit_deposit * it.qty; }
  const disc = discountFor(gross, await getRules(q));
  const names = new Map((await q.query('SELECT id, name FROM equipment WHERE id = ANY($1::int[])', [[...wanted.keys()]])).rows.map(e => [e.id, e.name]));
  return { client_id, client_name: cl.name, start_date, end_date, pickup_time, days, notes, items: clean,
           itemsText: clean.map(i => (i.qty > 1 ? i.qty + ' × ' : '') + names.get(i.equipment_id)).join(', '),
           gross: disc.gross, discount_pct: disc.pct, discount_amt: disc.amount, subtotal: disc.net, deposit: Math.round(deposit * 100) / 100 };
}

// What the booking looks like now, in the same shape, for the before → after list
async function currentBooking(q, rentalId) {
  const { r } = await describe(q, rentalId);
  const { rows: items } = await q.query('SELECT equipment_id, qty, unit_price, unit_deposit FROM rental_equipment WHERE rental_id=$1 ORDER BY id', [rentalId]);
  const { rows: [x] } = await q.query('SELECT notes FROM rentals WHERE id=$1', [rentalId]);
  return { ...r, notes: x.notes, itemList: items };
}
function bookingChanges(cur, plan) {
  const t = v => /^\d{1,2}:\d{2}$/.test(v || '') ? hhmm(v) : (v || '');
  const dates = (a, b) => a === b ? a : `${a} → ${b}`;
  const rows = [
    ['Client', cur.client, plan.client_name],
    ['Dates', dates(cur.start_date, cur.end_date), dates(plan.start_date, plan.end_date)],
    ['Pickup time', t(cur.pickup_time), t(plan.pickup_time)],
    ['Equipment', cur.items || '', plan.itemsText],
    ['Rental charge', money(cur.subtotal), money(plan.subtotal) + (plan.discount_amt ? ` (after ${plan.discount_pct}% discount)` : '')],
    ['Deposit', money(cur.deposit_amt), money(plan.deposit)],
    ['Notes', cur.notes || '', plan.notes || ''],
  ];
  const changes = rows.filter(([, a, b]) => String(a).replace(/ \(after.*\)$/, '') !== String(b).replace(/ \(after.*\)$/, ''))
                      .map(([field, from, to]) => ({ field, from: from || '(blank)', to: to || '(blank)' }));
  return changes;
}

// Write the approved plan onto the booking (inside a transaction)
async function applyPlan(c, rentalId, plan) {
  await c.query('DELETE FROM rental_equipment WHERE rental_id=$1', [rentalId]);
  for (const it of plan.items)
    await c.query('INSERT INTO rental_equipment (rental_id, equipment_id, qty, unit_price, unit_deposit) VALUES ($1,$2,$3,$4,$5)',
      [rentalId, it.equipment_id, it.qty, it.unit_price, it.unit_deposit]);
  await c.query(`UPDATE rentals SET client_id=$1, start_date=$2, end_date=$3, days=$4, pickup_time=$5, return_time=$6,
                   subtotal=$7, gross_amount=$8, discount_pct=$9, discount_amt=$10, deposit_amt=$11, notes=$12 WHERE id=$13`,
    [plan.client_id, plan.start_date, plan.end_date, plan.days, plan.pickup_time, RENTAL_END,
     plan.subtotal, plan.gross, plan.discount_pct, plan.discount_amt, plan.deposit, plan.notes, rentalId]);
}

// Close a waiting change when the booking is picked up / cancelled before anyone decided
async function closePendingChange(q, rentalId, why) {
  await q.query(`UPDATE rental_changes SET status='withdrawn', decided_at=NOW(), decision_note=$2
                 WHERE rental_id=$1 AND status='pending'`, [rentalId, why]);
}

// GET /api/rentals/:id/change — the change waiting for approval (with before → after), if any
router.get('/:id/change', async (req, res) => {
  const { rows: [ch] } = await db.query(
    `SELECT * FROM rental_changes WHERE rental_id=$1 AND status='pending'`, [req.params.id]);
  if (!ch) return res.json(null);
  // Re-check it against today's bookings so the Super Admin sees if it no longer fits
  let problem = null;
  try {
    const { rows: [r] } = await db.query('SELECT * FROM rentals WHERE id=$1', [req.params.id]);
    await planBooking(db, r, ch.proposed);
  } catch (err) { problem = err.message; }
  res.json({ ...ch, problem });
});

// POST /api/rentals/:id/change { reason, client_id, rental_date, return_date, pickup_time, equipment, notes }
router.post('/:id/change', async (req, res) => {
  const isSuper = req.user.role === 'superadmin';
  const reason = String((req.body || {}).reason || '').trim();
  if (!isSuper && reason.length < 3) return res.status(400).json({ error: 'Say why the booking is changing (e.g. "Client moved the date")' });
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    const { rows: [r] } = await c.query('SELECT * FROM rentals WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!r) throw httpErr(404, 'Rental not found');
    if (r.status !== 'booked') throw httpErr(400, `Only bookings that haven't been picked up can be edited (${ref(r.id)} is ${r.status})`);
    const { rows: [pending] } = await c.query(`SELECT * FROM rental_changes WHERE rental_id=$1 AND status='pending' FOR UPDATE`, [r.id]);
    if (pending && !isSuper && pending.requested_by !== req.user.id)
      throw httpErr(409, `${pending.requested_by_name} already asked to change ${ref(r.id)} — wait for the Super Admin to decide`);

    const items = (req.body.equipment || []).map(i => i.equipment_id).filter(Boolean);
    if (items.length) await c.query('SELECT id FROM equipment WHERE id = ANY($1::int[]) FOR UPDATE', [items]);
    const plan = await planBooking(c, r, req.body);
    const cur = await currentBooking(c, r.id);
    const changes = bookingChanges(cur, plan);
    if (!changes.length) throw httpErr(400, 'Nothing was changed');
    const summary = changes.map(x => `${x.field}: ${x.from} → ${x.to}`).join('; ');
    const proposed = { client_id: plan.client_id, rental_date: plan.start_date, return_date: plan.end_date,
                       pickup_time: plan.pickup_time, notes: plan.notes, equipment: plan.items };
    const d = await describe(c, r.id);

    if (isSuper) {
      // Super Admin: apply now (closing anyone else's waiting request for this booking)
      if (pending) await c.query(`UPDATE rental_changes SET status='rejected', decided_at=NOW(), decided_by=$2, decided_by_name=$3,
                                    decision_note='Replaced by an edit from the Super Admin' WHERE id=$1`, [pending.id, req.user.id, req.user.name]);
      await applyPlan(c, r.id, plan);
      await c.query(`INSERT INTO rental_changes (rental_id, status, requested_by, requested_by_name, reason, proposed, summary, changes,
                       decided_at, decided_by, decided_by_name) VALUES ($1,'applied',$2,$3,$4,$5,$6,$7,NOW(),$2,$3)`,
        [r.id, req.user.id, req.user.name, reason || null, proposed, summary, JSON.stringify(changes)]);
      await c.query('COMMIT');
      note(res, { action: 'booking_edit', entity: 'rental', entity_id: r.id, client_id: plan.client_id, changes,
        summary: `Edited booking ${ref(r.id)} for ${plan.client_name}${reason ? ' — ' + reason : ''}` });
      const { rows: [u] } = await db.query('SELECT * FROM rentals WHERE id=$1', [r.id]);
      return res.json({ applied: true, rental: await enrichRental(u), changes });
    }

    if (pending) await c.query(`UPDATE rental_changes SET status='withdrawn', decided_at=NOW(), decision_note='Replaced by a newer request' WHERE id=$1`, [pending.id]);
    const { rows: [ch] } = await c.query(
      `INSERT INTO rental_changes (rental_id, requested_by, requested_by_name, reason, proposed, summary, changes)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [r.id, req.user.id, req.user.name, reason, proposed, summary, JSON.stringify(changes)]);
    await c.query('COMMIT');
    note(res, { action: 'booking_edit_request', entity: 'rental', entity_id: r.id, client_id: d.client_id, changes,
      summary: `Asked the Super Admin to change booking ${ref(r.id)} for ${cur.client} — ${reason}` });
    res.status(201).json({ applied: false, request: ch, changes });
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    res.status(err.status || 500).json({ error: err.message });
  } finally { c.release(); }
});

// POST /api/rentals/:id/change/approve — Super Admin applies the waiting change
router.post('/:id/change/approve', requireSuperAdmin, async (req, res) => {
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    const { rows: [r] } = await c.query('SELECT * FROM rentals WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!r) throw httpErr(404, 'Rental not found');
    const { rows: [ch] } = await c.query(`SELECT * FROM rental_changes WHERE rental_id=$1 AND status='pending' FOR UPDATE`, [r.id]);
    if (!ch) throw httpErr(404, 'There is no change waiting for this booking');
    if (r.status !== 'booked') throw httpErr(400, `${ref(r.id)} is no longer a booking (it is ${r.status}), so the change can't be applied`);
    const ids = (ch.proposed.equipment || []).map(i => i.equipment_id);
    if (ids.length) await c.query('SELECT id FROM equipment WHERE id = ANY($1::int[]) FOR UPDATE', [ids]);
    let plan;
    try { plan = await planBooking(c, r, ch.proposed); }
    catch (err) { throw httpErr(err.status || 400, `Can't approve: ${err.message}. Reject it, or edit the booking yourself.`); }
    const cur = await currentBooking(c, r.id);
    const changes = bookingChanges(cur, plan);
    await applyPlan(c, r.id, plan);
    await c.query(`UPDATE rental_changes SET status='approved', decided_at=NOW(), decided_by=$2, decided_by_name=$3, changes=$4 WHERE id=$1`,
      [ch.id, req.user.id, req.user.name, JSON.stringify(changes)]);
    await c.query('COMMIT');
    note(res, { action: 'booking_edit_approve', entity: 'rental', entity_id: r.id, client_id: plan.client_id, changes,
      summary: `Approved ${ch.requested_by_name}'s change to booking ${ref(r.id)} for ${plan.client_name} (reason: ${ch.reason})` });
    const { rows: [u] } = await db.query('SELECT * FROM rentals WHERE id=$1', [r.id]);
    res.json({ ok: true, rental: await enrichRental(u), changes });
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    res.status(err.status || 500).json({ error: err.message });
  } finally { c.release(); }
});

// POST /api/rentals/:id/change/reject { note } — Super Admin rejects, or the person who asked withdraws
router.post('/:id/change/reject', async (req, res) => {
  const { rows: [ch] } = await db.query(`SELECT * FROM rental_changes WHERE rental_id=$1 AND status='pending'`, [req.params.id]);
  if (!ch) return res.status(404).json({ error: 'There is no change waiting for this booking' });
  const isSuper = req.user.role === 'superadmin', own = ch.requested_by === req.user.id;
  if (!isSuper && !own) return res.status(403).json({ error: 'Only the Super Admin or the person who asked can cancel this change' });
  const why = String((req.body || {}).note || '').trim() || null;
  const status = own && !isSuper ? 'withdrawn' : (own ? 'withdrawn' : 'rejected');
  await db.query(`UPDATE rental_changes SET status=$2, decided_at=NOW(), decided_by=$3, decided_by_name=$4, decision_note=$5 WHERE id=$1`,
    [ch.id, status, req.user.id, req.user.name, why]);
  const d = await describe(db, ch.rental_id);
  note(res, { action: status === 'rejected' ? 'booking_edit_reject' : 'booking_edit_withdraw', entity: 'rental', entity_id: ch.rental_id, client_id: d.client_id,
    summary: status === 'rejected'
      ? `Rejected ${ch.requested_by_name}'s change to booking ${ref(ch.rental_id)}${why ? ' — ' + why : ''} (asked: ${ch.summary})`
      : `Withdrew their change request for booking ${ref(ch.rental_id)}` });
  res.json({ ok: true, status });
});

// GET /api/rentals/:id/changes — history of changes to this booking
router.get('/:id/changes', async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, status, requested_at, requested_by_name, reason, summary, changes, decided_at, decided_by_name, decision_note
     FROM rental_changes WHERE rental_id=$1 ORDER BY id DESC LIMIT 30`, [req.params.id]);
  res.json(rows);
});

module.exports = router;
