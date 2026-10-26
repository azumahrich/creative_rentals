const router = require('express').Router();
const db     = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');

router.use(requireAuth);

// GET /api/equipment
router.get('/', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM equipment WHERE NOT archived ORDER BY category, name');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/equipment  (admin only)
router.post('/', requireAdmin, async (req, res) => {
  const { serial, name, category, price, deposit, available, total } = req.body;
  if (!name || !category) return res.status(400).json({ error: 'name and category required' });
  try {
    const { rows } = await db.query(
      `INSERT INTO equipment (serial, name, category, price, deposit, available, total)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [serial||null, name, category, price||0, deposit||0,
       available !== undefined ? available : 1,
       total !== undefined ? total : 1]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Serial number already exists' });
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/equipment/:id  (admin only)
router.patch('/:id', requireAdmin, async (req, res) => {
  const fields = ['serial','name','category','price','deposit','available','total'];
  const updates = [];
  const vals    = [];
  let i = 1;

  fields.forEach(f => {
    if (req.body[f] !== undefined) { updates.push(`${f}=$${i++}`); vals.push(req.body[f]); }
  });
  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });

  vals.push(req.params.id);
  try {
    const { rows } = await db.query(
      `UPDATE equipment SET ${updates.join(',')} WHERE id=$${i} RETURNING *`, vals
    );
    if (!rows.length) return res.status(404).json({ error: 'Equipment not found' });
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Serial number already exists' });
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/equipment/:id  (admin only)
// - Blocked only while the item is out on an active/overdue rental
// - If it appears in past rentals, it is archived (hidden) so old invoices stay intact
// - Otherwise it is deleted outright
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const { rows: out } = await db.query(
      `SELECT r.id FROM rental_equipment re JOIN rentals r ON r.id = re.rental_id
       WHERE re.equipment_id=$1 AND r.status IN ('active','overdue') LIMIT 1`, [req.params.id]);
    if (out.length)
      return res.status(409).json({ error: `This item is out on rental #R-${String(out[0].id).padStart(4,'0')}. Mark that rental Returned first.` });

    const { rows: used } = await db.query(
      'SELECT 1 FROM rental_equipment WHERE equipment_id=$1 LIMIT 1', [req.params.id]);
    const { rowCount } = used.length
      ? await db.query('UPDATE equipment SET archived=TRUE WHERE id=$1 AND NOT archived', [req.params.id])
      : await db.query('DELETE FROM equipment WHERE id=$1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Equipment not found' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
