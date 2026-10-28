const router = require('express').Router();
const db     = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');

/*
 * Photos are stored in the database (table equipment_photos), not on disk,
 * because Render's web service disk is wiped on every deploy.
 * The browser shrinks each photo before upload (~50–100 KB).
 */
const MAX_PHOTO_BYTES = 1.5 * 1024 * 1024;
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

// GET /api/equipment/:id/photo — public so <img> tags can load it (equipment photos aren't sensitive)
router.get('/:id/photo', async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT mime, data, updated_at FROM equipment_photos WHERE equipment_id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).end();
    res.set('Content-Type', rows[0].mime);
    // URLs carry ?v=<timestamp>, so a changed photo gets a new URL — safe to cache for a long time
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(rows[0].data);
  } catch (err) { res.status(500).end(); }
});

router.use(requireAuth);

const LIST_SQL = `
  SELECT e.*, (p.equipment_id IS NOT NULL) AS has_photo,
         COALESCE(FLOOR(EXTRACT(EPOCH FROM p.updated_at))::bigint, 0) AS photo_v
  FROM equipment e
  LEFT JOIN equipment_photos p ON p.equipment_id = e.id`;

// GET /api/equipment
router.get('/', async (req, res) => {
  try {
    const { rows } = await db.query(`${LIST_SQL} WHERE NOT e.archived ORDER BY e.category, e.name`);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/equipment/:id
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await db.query(`${LIST_SQL} WHERE e.id=$1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Equipment not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/equipment  (admin only)
router.post('/', requireAdmin, async (req, res) => {
  const { serial, name, category, price, deposit, available, total } = req.body;
  if (!name || !category) return res.status(400).json({ error: 'name and category required' });
  const tot = total !== undefined ? Math.max(1, parseInt(total) || 1) : 1;
  try {
    const { rows } = await db.query(
      `INSERT INTO equipment (serial, name, category, price, deposit, available, total)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [serial||null, name, category, price||0, deposit||0,
       available !== undefined ? Math.min(tot, Math.max(0, parseInt(available) || 0)) : tot, tot]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Serial number already exists' });
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/equipment/:id  (admin only)
// Changing the total quantity adjusts "available" by the same amount, so units
// currently out on rental stay counted as out.
router.patch('/:id', requireAdmin, async (req, res) => {
  try {
    const { rows: found } = await db.query('SELECT total, available FROM equipment WHERE id=$1', [req.params.id]);
    if (!found.length) return res.status(404).json({ error: 'Equipment not found' });
    const cur = found[0];

    const body = { ...req.body };
    if (body.total !== undefined) {
      const newTotal = Math.max(1, parseInt(body.total) || 1);
      const out = cur.total - cur.available;                 // units currently rented out
      if (newTotal < out)
        return res.status(400).json({ error: `${out} of this item are out on rental, so the total can't be less than ${out}` });
      body.total = newTotal;
      if (body.available === undefined) body.available = newTotal - out;
    }

    const fields = ['serial','name','category','price','deposit','available','total'];
    const updates = [], vals = [];
    let i = 1;
    fields.forEach(f => {
      if (body[f] !== undefined) { updates.push(`${f}=$${i++}`); vals.push(f === 'serial' ? (body[f] || null) : body[f]); }
    });
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });

    vals.push(req.params.id);
    const { rows } = await db.query(
      `UPDATE equipment SET ${updates.join(',')} WHERE id=$${i} RETURNING *`, vals);
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Serial number already exists' });
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/equipment/:id/photo  (admin only) — body: { image: "data:image/jpeg;base64,..." }
router.put('/:id/photo', requireAdmin, async (req, res) => {
  const m = /^data:(image\/[a-z]+);base64,(.+)$/i.exec(req.body.image || '');
  if (!m) return res.status(400).json({ error: 'Please choose a picture file' });
  const mime = m[1].toLowerCase();
  if (!PHOTO_TYPES.includes(mime)) return res.status(400).json({ error: 'Photo must be JPG, PNG or WebP' });
  const data = Buffer.from(m[2], 'base64');
  if (!data.length) return res.status(400).json({ error: 'The photo is empty' });
  if (data.length > MAX_PHOTO_BYTES) return res.status(413).json({ error: 'Photo is too large (max 1.5 MB)' });
  try {
    const { rowCount } = await db.query('SELECT 1 FROM equipment WHERE id=$1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Equipment not found' });
    const { rows } = await db.query(
      `INSERT INTO equipment_photos (equipment_id, mime, data, updated_at) VALUES ($1,$2,$3,NOW())
       ON CONFLICT (equipment_id) DO UPDATE SET mime=EXCLUDED.mime, data=EXCLUDED.data, updated_at=NOW()
       RETURNING FLOOR(EXTRACT(EPOCH FROM updated_at))::bigint AS photo_v`,
      [req.params.id, mime, data]);
    res.json({ ok: true, photo_v: rows[0].photo_v });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/equipment/:id/photo  (admin only)
router.delete('/:id/photo', requireAdmin, async (req, res) => {
  try {
    await db.query('DELETE FROM equipment_photos WHERE equipment_id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
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
