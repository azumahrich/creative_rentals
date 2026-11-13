const router = require('express').Router();
// IDs in the address must be whole numbers (anything else is simply 'not found')
router.param('id', (req, res, next, id) => /^\d{1,9}$/.test(id) ? next() : res.status(404).json({ error: 'Not found' }));
const db     = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const activity = require('../middleware/activity');   // (named so it doesn't clash with a payment's 'note' field)
const METHOD = { cash:'Cash', momo:'Mobile Money', bank_transfer:'Bank transfer', cheque:'Cheque', other:'Other' };

router.use(requireAuth);

// GET /api/payments?rental_id=X
// Staff can record payments; payment history and deleting payments are admin-only
router.get('/', requireAdmin, async (req, res) => {
  const { rental_id } = req.query;
  try {
    const base = `SELECT p.*, r.status AS rental_status, c.name AS client_name
                  FROM payments p JOIN rentals r ON r.id = p.rental_id JOIN clients c ON c.id = r.client_id`;
    const sql = rental_id
      ? `${base} WHERE p.rental_id=$1 ORDER BY p.paid_at DESC`
      : `${base} ORDER BY p.paid_at DESC LIMIT 500`;
    const { rows } = rental_id
      ? await db.query(sql, [rental_id])
      : await db.query(sql);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/payments
router.post('/', async (req, res) => {
  const { rental_id, method, reference, note } = req.body;
  const amount = Math.round(+req.body.amount * 100) / 100;
  const request_id = String(req.body.request_id || '').slice(0, 80) || null;
  if (!rental_id || !req.body.amount) return res.status(400).json({ error: 'rental_id and amount required' });
  if (!(amount > 0) || amount > 10000000) return res.status(400).json({ error: 'Enter a valid amount' });
  if (method && !METHOD[method]) return res.status(400).json({ error: 'Unknown payment method' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // Same save arriving twice (double tap / retry)? Hand back the payment already recorded.
    if (request_id) {
      const { rows: [dup] } = await client.query('SELECT * FROM payments WHERE request_id=$1', [request_id]);
      if (dup) { await client.query('ROLLBACK'); return res.status(200).json({ ...dup, duplicate: true }); }
    }
    const { rows: [rental] } = await client.query('SELECT id, status FROM rentals WHERE id=$1 FOR UPDATE', [rental_id]);
    if (!rental) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Rental not found' }); }
    if (rental.status === 'cancelled') { await client.query('ROLLBACK'); return res.status(400).json({ error: `${activity.ref(rental_id)} was cancelled — payments can't be added to it` }); }
    const { rows: [pmt] } = await client.query(
      `INSERT INTO payments (rental_id, amount, method, reference, note, request_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [rental_id, amount, method||'cash', reference||null, note||null, request_id]
    );
    // Update rental total_paid
    await client.query(
      'UPDATE rentals SET total_paid = total_paid + $1 WHERE id = $2',
      [amount, rental_id]
    );
    const { rows: [r] } = await client.query(
      'SELECT r.id, r.client_id, c.name FROM rentals r JOIN clients c ON c.id = r.client_id WHERE r.id=$1', [rental_id]);
    await client.query('COMMIT');
    activity.note(res, { action: 'payment_create', entity: 'payment', entity_id: pmt.id, client_id: r && r.client_id,
      summary: `Recorded payment of ${activity.money(pmt.amount)} (${METHOD[pmt.method] || pmt.method}${pmt.reference ? ', ref ' + pmt.reference : ''}) on ${activity.ref(rental_id)}${r ? ' for ' + r.name : ''}` });
    res.status(201).json(pmt);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505' && request_id) {      // the twin request won the race — return its payment
      const { rows: [dup] } = await db.query('SELECT * FROM payments WHERE request_id=$1', [request_id]);
      if (dup) return res.status(200).json({ ...dup, duplicate: true });
    }
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// DELETE /api/payments/:id
router.delete('/:id', requireAdmin, async (req, res) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM payments WHERE id=$1', [req.params.id]);
    if (!rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Payment not found' }); }
    const pmt = rows[0];
    await client.query('DELETE FROM payments WHERE id=$1', [req.params.id]);
    await client.query(
      'UPDATE rentals SET total_paid = total_paid - $1 WHERE id = $2',
      [pmt.amount, pmt.rental_id]
    );
    const { rows: [r] } = await client.query(
      'SELECT r.client_id, c.name FROM rentals r JOIN clients c ON c.id = r.client_id WHERE r.id=$1', [pmt.rental_id]);
    await client.query('COMMIT');
    activity.note(res, { action: 'payment_delete', entity: 'payment', entity_id: pmt.id, client_id: r && r.client_id,
      changes: [{ field: 'Payment', from: `${activity.money(pmt.amount)} ${METHOD[pmt.method] || pmt.method} on ${new Date(pmt.paid_at).toISOString().slice(0,10)}`, to: '(deleted)' }],
      summary: `Deleted payment of ${activity.money(pmt.amount)} (${METHOD[pmt.method] || pmt.method}${pmt.reference ? ', ref ' + pmt.reference : ''}) from ${activity.ref(pmt.rental_id)}${r ? ' for ' + r.name : ''}` });
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
