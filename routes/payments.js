const router = require('express').Router();
const db     = require('../db');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

// GET /api/payments?rental_id=X
router.get('/', async (req, res) => {
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
    await client.query('COMMIT');
    res.status(201).json(pmt);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// DELETE /api/payments/:id
router.delete('/:id', async (req, res) => {
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
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
