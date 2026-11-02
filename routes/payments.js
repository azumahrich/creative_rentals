const router = require('express').Router();
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
    const sql = rental_id
      ? 'SELECT * FROM payments WHERE rental_id=$1 ORDER BY paid_at DESC'
      : 'SELECT * FROM payments ORDER BY paid_at DESC LIMIT 200';
    const { rows } = rental_id
      ? await db.query(sql, [rental_id])
      : await db.query(sql);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/payments
router.post('/', async (req, res) => {
  const { rental_id, amount, method, reference, note } = req.body;
  if (!rental_id || !amount) return res.status(400).json({ error: 'rental_id and amount required' });
  if (!(+amount > 0)) return res.status(400).json({ error: 'Amount must be more than 0' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // Insert payment
    const { rows: [pmt] } = await client.query(
      `INSERT INTO payments (rental_id, amount, method, reference, note)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [rental_id, amount, method||'cash', reference||null, note||null]
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
