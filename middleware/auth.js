const jwt = require('jsonwebtoken');
const db  = require('../db');

const SECRET = process.env.JWT_SECRET || 'dev_secret_change_in_production';

/**
 * Verify JWT, then re-check the account in the database so that role changes
 * and disabled/removed accounts take effect immediately.
 * Attaches req.user = { id, username, name, role }
 */
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentication required' });

  let payload;
  try { payload = jwt.verify(token, SECRET); }
  catch { return res.status(401).json({ error: 'Invalid or expired token' }); }

  try {
    const { rows } = await db.query(
      'SELECT id, username, name, role FROM users WHERE id=$1 AND active', [payload.id]);
    if (!rows.length) return res.status(401).json({ error: 'Account disabled or removed' });
    req.user = rows[0];
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

const isAdminRole = role => role === 'admin' || role === 'superadmin';

/** Admin or Super Admin — must be used AFTER requireAuth */
function requireAdmin(req, res, next) {
  if (!req.user || !isAdminRole(req.user.role)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

/** Super Admin only — must be used AFTER requireAuth */
function requireSuperAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'superadmin') {
    return res.status(403).json({ error: 'Super Admin access required' });
  }
  next();
}

/** Sign a token for a user row */
function signToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, name: user.name, role: user.role },
    SECRET,
    { expiresIn: '12h' }
  );
}

module.exports = { requireAuth, requireAdmin, requireSuperAdmin, signToken, isAdminRole };
