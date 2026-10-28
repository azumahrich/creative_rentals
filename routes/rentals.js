const router = require('express').Router();
const db     = require('../db');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

// ─── Helpers ─────────────────────────────────────────────────────────────────
async function enrichRental(row, client) {
  const q = client || db;
  const { rows: items } = await q.query(
    `SELECT re.*, e.name, e.serial, e.category
     FROM rental_equipment re
     JOIN equipment e ON e.id = re.equipment_id
     WHERE re.rental_id = $1`, [row.id]
  );
  const { rows: payments } = await q.query(
    'SELECT * FROM payments WHERE rental_id=$1 ORDER BY paid_at', [row.id]
  );
  return { ...row, equipment: items, payments };
}

// Rentals start at 8:00 AM on the rental date and end at 5:00 PM on the return date
// (same day by default). Charged per 8am–5pm day.
const RENTAL_START = '08:00', RENTAL_END = '17:00';

// Active rentals not returned by 5:00 PM (Ghana time) on their date become overdue
const OVERDUE_SQL = `UPDATE rentals SET status='overdue'
  WHERE status='active' AND (end_date + TIME '17:00') < (NOW() AT TIME ZONE 'Africa/Accra')`;
const markOverdue = () => db.query(OVERDUE_SQL);

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
  sql += ' ORDER BY r.created_at DESC';

  try {
    const { rows } = await db.query(sql, p);
    // Enrich each rental with equipment + payments
    const result = await Promise.all(rows.map(r => enrichRental(r)));
    res.json(result);
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
    res.json(await enrichRental(rows[0]));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/rentals
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
  // Pickup 8:00 AM on rental date, return by 5:00 PM on return date; days counted inclusively
  const start_date = rental_date, end_date = return_date;
  const days = Math.round((Date.parse(end_date) - Date.parse(start_date)) / 86400000) + 1;

  const pgClient = await db.connect();
  try {
    await pgClient.query('BEGIN');

    // Calc totals from equipment items
    let subtotal = 0, deposit = 0;
    for (const item of equipment) {
      subtotal += (item.unit_price  || 0) * (item.qty || 1) * (days || 1);
      deposit  += (item.unit_deposit|| 0) * (item.qty || 1);
    }

    const { rows: [rental] } = await pgClient.query(
      `INSERT INTO rentals (client_id, start_date, end_date, days, subtotal, deposit_amt, pickup_time, return_time, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [client_id, start_date, end_date, days, subtotal, deposit,
       RENTAL_START, RENTAL_END, notes||null]
    );

    for (const item of equipment) {
      await pgClient.query(
        `INSERT INTO rental_equipment (rental_id, equipment_id, qty, unit_price, unit_deposit)
         VALUES ($1,$2,$3,$4,$5)`,
        [rental.id, item.equipment_id, item.qty||1, item.unit_price||0, item.unit_deposit||0]
      );
      // Decrement availability — refuse if there isn't enough stock
      const { rowCount: ok } = await pgClient.query(
        'UPDATE equipment SET available = available - $1 WHERE id = $2 AND available >= $1',
        [item.qty||1, item.equipment_id]
      );
      if (!ok) {
        const { rows: [e] } = await pgClient.query('SELECT name, available FROM equipment WHERE id=$1', [item.equipment_id]);
        await pgClient.query('ROLLBACK');
        return res.status(409).json({ error: e ? `Only ${e.available} × ${e.name} available` : 'Equipment not found' });
      }
    }

    await pgClient.query('COMMIT');
    const full = await enrichRental(rental);
    res.status(201).json(full);
  } catch (err) {
    await pgClient.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    pgClient.release();
  }
});

// PATCH /api/rentals/:id
router.patch('/:id', async (req, res) => {
  // Dates/prices are fixed once a rental is created (recreate the rental to change them)
  const allowed = ['status','notes'];
  const updates = [];
  const vals    = [];
  let i = 1;

  allowed.forEach(f => {
    if (req.body[f] !== undefined) { updates.push(`${f}=$${i++}`); vals.push(req.body[f]); }
  });
  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });

  const pgClient = await db.connect();
  try {
    await pgClient.query('BEGIN');
    vals.push(req.params.id);
    const { rows } = await pgClient.query(
      `UPDATE rentals SET ${updates.join(',')} WHERE id=$${i} RETURNING *`, vals
    );
    if (!rows.length) { await pgClient.query('ROLLBACK'); return res.status(404).json({ error: 'Rental not found' }); }

    // If status changed to 'returned', restore equipment availability
    if (req.body.status === 'returned') {
      const { rows: items } = await pgClient.query(
        'SELECT * FROM rental_equipment WHERE rental_id=$1', [req.params.id]
      );
      for (const item of items) {
        await pgClient.query(
          'UPDATE equipment SET available = available + $1 WHERE id = $2',
          [item.qty, item.equipment_id]
        );
      }
    }

    await pgClient.query('COMMIT');
    const full = await enrichRental(rows[0], pgClient);
    res.json(full);
  } catch (err) {
    await pgClient.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    pgClient.release();
  }
});

// DELETE /api/rentals/:id  (only cancellable/active)
router.delete('/:id', async (req, res) => {
  const pgClient = await db.connect();
  try {
    await pgClient.query('BEGIN');
    const { rows } = await pgClient.query('SELECT * FROM rentals WHERE id=$1', [req.params.id]);
    if (!rows.length) { await pgClient.query('ROLLBACK'); return res.status(404).json({ error: 'Rental not found' }); }

    const rental = rows[0];
    // Restore availability if not already returned
    if (rental.status !== 'returned') {
      const { rows: items } = await pgClient.query(
        'SELECT * FROM rental_equipment WHERE rental_id=$1', [req.params.id]
      );
      for (const item of items) {
        await pgClient.query(
          'UPDATE equipment SET available = available + $1 WHERE id = $2',
          [item.qty, item.equipment_id]
        );
      }
    }

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
