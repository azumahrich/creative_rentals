const router = require('express').Router();
const bcrypt = require('bcryptjs');
const db     = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');

/*
 * Who can do what:
 *   Super Admin — add/edit/disable/remove anyone (staff, admins, other super admins)
 *   Admin       — add/edit/disable/remove STAFF only; can edit own name & password
 *   Staff       — no access
 * Safety: you can't remove or disable yourself or change your own role,
 *         and there must always be at least one active Super Admin.
 */
router.use(requireAuth, requireAdmin);

const ROLES = ['superadmin', 'admin', 'staff'];
const isSuper = u => u.role === 'superadmin';

function canManage(actor, target) {
  if (isSuper(actor)) return true;
  if (actor.role === 'admin') return target.role === 'staff' || target.id === actor.id;
  return false;
}

async function activeSuperCount(excludeId) {
  const { rows } = await db.query(
    "SELECT COUNT(*)::int AS n FROM users WHERE role='superadmin' AND active AND id <> $1",
    [excludeId || 0]);
  return rows[0].n;
}

// GET /api/users
router.get('/', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, username, name, role, active, created_at FROM users
       ORDER BY CASE role WHEN 'superadmin' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, id`);
    res.json(rows.map(u => ({ ...u, can_manage: canManage(req.user, u) })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/users
router.post('/', async (req, res) => {
  const { username, password, name } = req.body;
  const role = req.body.role || 'staff';
  if (!username || !password || !name) return res.status(400).json({ error: 'username, password and name required' });
  if (!ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role' });
  if (role !== 'staff' && !isSuper(req.user))
    return res.status(403).json({ error: 'Only the Super Admin can create admin accounts' });

  try {
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await db.query(
      `INSERT INTO users (username, password, name, role)
       VALUES ($1,$2,$3,$4) RETURNING id, username, name, role, active, created_at`,
      [username.trim().toLowerCase(), hash, name.trim(), role]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Username already exists' });
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/users/:id
router.patch('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const self = id === req.user.id;
  try {
    const { rows: found } = await db.query('SELECT id, role, active FROM users WHERE id=$1', [id]);
    if (!found.length) return res.status(404).json({ error: 'User not found' });
    const target = found[0];
    if (!canManage(req.user, target))
      return res.status(403).json({ error: 'Only the Super Admin can change admin accounts' });

    const { name, role, active, password } = req.body;
    if (self && role !== undefined && role !== target.role)
      return res.status(400).json({ error: 'You cannot change your own role' });
    if (self && active === false)
      return res.status(400).json({ error: 'You cannot disable your own account' });
    if (role !== undefined && !ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role' });
    if (role !== undefined && role !== 'staff' && !isSuper(req.user))
      return res.status(403).json({ error: 'Only the Super Admin can make someone an admin' });

    // Keep at least one active Super Admin
    const losesSuper = target.role === 'superadmin' &&
      ((role !== undefined && role !== 'superadmin') || active === false);
    if (losesSuper && (await activeSuperCount(id)) === 0)
      return res.status(400).json({ error: 'There must be at least one active Super Admin' });

    const updates = [], vals = [];
    let i = 1;
    if (name     !== undefined) { updates.push(`name=$${i++}`);   vals.push(name); }
    if (role     !== undefined) { updates.push(`role=$${i++}`);   vals.push(role); }
    if (active   !== undefined) { updates.push(`active=$${i++}`); vals.push(!!active); }
    if (password)               { updates.push(`password=$${i++}`); vals.push(await bcrypt.hash(password, 10)); }
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });

    vals.push(id);
    const { rows } = await db.query(
      `UPDATE users SET ${updates.join(',')} WHERE id=$${i} RETURNING id, username, name, role, active`, vals);
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/users/:id
router.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'Cannot delete your own account' });
  try {
    const { rows: found } = await db.query('SELECT id, role, active FROM users WHERE id=$1', [id]);
    if (!found.length) return res.status(404).json({ error: 'User not found' });
    const target = found[0];
    if (!canManage(req.user, target))
      return res.status(403).json({ error: 'Only the Super Admin can remove admin accounts' });
    if (target.role === 'superadmin' && (await activeSuperCount(id)) === 0)
      return res.status(400).json({ error: 'There must be at least one active Super Admin' });
    await db.query('DELETE FROM users WHERE id=$1', [id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
