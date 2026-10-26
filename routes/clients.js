const router = require('express').Router();
const db     = require('../db');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

// GET /api/clients?q=search
router.get('/', async (req, res) => {
  const { q } = req.query;
  try {
    const sql = q
      ? `SELECT * FROM clients
         WHERE name ILIKE $1 OR phone ILIKE $1 OR ghana_card ILIKE $1 OR company ILIKE $1
         ORDER BY name`
      : 'SELECT * FROM clients ORDER BY name';
    const { rows } = q
      ? await db.query(sql, [`%${q}%`])
      : await db.query(sql);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/clients/:id
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM clients WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Client not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/clients
router.post('/', async (req, res) => {
  const { name, phone, email, company, id_number, ghana_card, notes, joined } = req.body;
  if (!name) return res.status(400).json({ error: 'Client name required' });
  try {
    const { rows } = await db.query(
      `INSERT INTO clients (name, phone, email, company, id_number, ghana_card, notes, joined)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [name, phone||null, email||null, company||null, id_number||null,
       ghana_card||null, notes||null, joined||new Date().toISOString().slice(0,10)]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/clients/:id
router.patch('/:id', async (req, res) => {
  const fields = ['name','phone','email','company','id_number','ghana_card','notes','joined'];
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
      `UPDATE clients SET ${updates.join(',')} WHERE id=$${i} RETURNING *`, vals
    );
    if (!rows.length) return res.status(404).json({ error: 'Client not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/clients/:id
router.delete('/:id', async (req, res) => {
  try {
    const { rowCount } = await db.query('DELETE FROM clients WHERE id=$1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Client not found' });
    res.json({ ok: true });
  } catch (err) {
    if (err.code === '23503') return res.status(409).json({ error: 'Client has existing rentals' });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
