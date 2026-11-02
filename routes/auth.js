const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const db      = require('../db');
const { signToken, requireAuth } = require('../middleware/auth');
const { note } = require('../middleware/activity');

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: 'Username and password required' });

  try {
    const { rows } = await db.query(
      'SELECT * FROM users WHERE username = $1 AND active = TRUE',
      [username.trim().toLowerCase()]
    );
    const user = rows[0];
    const failed = why => {
      note(res, { force: true, action: 'login_failed', entity: 'user', entity_id: user && user.id,
        user: user ? { id: user.id, username: user.username, name: user.name, role: user.role } : { username: String(username).trim().toLowerCase() },
        summary: `Failed sign-in for "${String(username).trim()}" — ${why}` });
      return res.status(401).json({ error: 'Invalid credentials' });
    };
    if (!user) {
      const { rows: off } = await db.query('SELECT 1 FROM users WHERE username=$1', [username.trim().toLowerCase()]);
      return failed(off.length ? 'account is disabled' : 'no such username');
    }

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return failed('wrong password');

    await db.query('UPDATE users SET last_login_at=NOW(), last_seen_at=NOW() WHERE id=$1', [user.id]);
    note(res, { action: 'login', entity: 'user', entity_id: user.id,
      user: { id: user.id, username: user.username, name: user.name, role: user.role }, summary: 'Signed in' });
    const token = signToken(user);
    res.json({ token, user: { id: user.id, username: user.username, name: user.name, role: user.role } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/auth/me — validate stored token and return user info
router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// POST /api/auth/change-password — any logged-in user changes their own password
router.post('/change-password', requireAuth, async (req, res) => {
  const { current, password } = req.body || {};
  if (!current || !password) return res.status(400).json({ error: 'Enter your current password and a new password' });
  if (String(password).length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
  try {
    const { rows } = await db.query('SELECT password FROM users WHERE id=$1', [req.user.id]);
    if (!rows.length || !(await bcrypt.compare(current, rows[0].password)))
      return res.status(401).json({ error: 'Your current password is wrong' });
    await db.query('UPDATE users SET password=$1 WHERE id=$2', [await bcrypt.hash(password, 10), req.user.id]);
    note(res, { action: 'password_change', entity: 'user', entity_id: req.user.id, summary: 'Changed their own password' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
