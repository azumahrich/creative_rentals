const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const db      = require('../db');
const { signToken, requireAuth } = require('../middleware/auth');
const { note } = require('../middleware/activity');

// POST /api/auth/login
// Too many wrong passwords from one device for one username → wait 15 minutes
const FAILS = new Map(), MAX_FAILS = 8, WINDOW = 15 * 60 * 1000;
const failKey = (req, u) => req.ip + '|' + u;
function tooMany(key) {
  const f = FAILS.get(key); if (!f) return false;
  if (Date.now() - f.first > WINDOW) { FAILS.delete(key); return false; }
  return f.n >= MAX_FAILS;
}
function addFail(key) {
  const f = FAILS.get(key);
  if (!f || Date.now() - f.first > WINDOW) FAILS.set(key, { n: 1, first: Date.now() }); else f.n++;
  if (FAILS.size > 5000) for (const [k, v] of FAILS) if (Date.now() - v.first > WINDOW) FAILS.delete(k);
}

// GET /api/auth/config — what the sign-in screen needs to know (is email switched on?)
router.get('/config', (req, res) => res.json({ email: require('../lib/email').configured() }));

router.post('/login', async (req, res) => {
  const username = typeof req.body.username === 'string' ? req.body.username : '';
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (!username.trim() || !password)
    return res.status(400).json({ error: 'Username and password required' });
  const key = failKey(req, username.trim().toLowerCase());
  if (tooMany(key))
    return res.status(429).json({ error: 'Too many wrong attempts. Wait 15 minutes, or use "Forgot password?" / ask your Super Admin.' });

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
      addFail(key);
      return res.status(401).json({ error: 'Wrong username or password' });
    };
    if (!user) {
      const { rows: off } = await db.query('SELECT 1 FROM users WHERE username=$1', [username.trim().toLowerCase()]);
      return failed(off.length ? 'account is disabled' : 'no such username');
    }

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return failed('wrong password');

    FAILS.delete(key);
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
router.get('/me', requireAuth, async (req, res) => {
  const { rows: [u] } = await db.query('SELECT email FROM users WHERE id=$1', [req.user.id]).catch(() => ({ rows: [{}] }));
  res.json({ user: { ...req.user, email: (u && u.email) || null } });
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

// PUT /api/auth/my-email { email } — anyone can add the email used for "Forgot password"
router.put('/my-email', requireAuth, async (req, res) => {
  const v = String((req.body || {}).email || '').trim().toLowerCase();
  if (v && !require('../lib/email').isEmail(v)) return res.status(400).json({ error: 'That email address is not valid' });
  try {
    const { rows: [b] } = await db.query('SELECT email FROM users WHERE id=$1', [req.user.id]);
    await db.query('UPDATE users SET email=$1 WHERE id=$2', [v || null, req.user.id]);
    note(res, { action: 'user_update', entity: 'user', entity_id: req.user.id,
      changes: [{ field: 'Email', from: (b && b.email) || '(blank)', to: v || '(blank)' }],
      summary: v ? `Set their own email to ${v}` : 'Removed their own email' });
    res.json({ ok: true, email: v || null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Forgot password (by email) ──────────────────────────────────────────────
const crypto = require('crypto');
const email  = require('../lib/email');
const hashToken = t => crypto.createHash('sha256').update(String(t)).digest('hex');
const SAME_ANSWER = { ok: true, message: 'If that account has an email address, a reset link is on its way. Check your inbox (and spam) — the link expires in 30 minutes.' };

// POST /api/auth/forgot { login } — username or email. Always gives the same answer,
// so nobody can use it to find out which usernames or emails exist.
router.post('/forgot', async (req, res) => {
  const login = String((req.body || {}).login || '').trim().toLowerCase();
  if (!login) return res.status(400).json({ error: 'Enter your username or email' });
  try {
    if (!email.configured())
      return res.status(503).json({ error: 'Email is not set up on this app yet. Ask your Super Admin to reset your password.' });
    const { rows: [u] } = await db.query(
      `SELECT id, username, name, role, email FROM users
       WHERE active AND (username=$1 OR LOWER(TRIM(email))=$1) ORDER BY (username=$1) DESC LIMIT 1`, [login]);
    if (!u || !email.isEmail(u.email)) {
      note(res, { force: true, action: 'password_reset_request', entity: 'user', entity_id: u && u.id,
        user: u ? { id: u.id, username: u.username, name: u.name, role: u.role } : { username: login },
        summary: `"Forgot password" for "${login}" — not sent (${u ? 'no email on the account' : 'no such account'})` });
      return res.json(SAME_ANSWER);
    }
    // At most 3 links per account per hour
    const { rows: [n] } = await db.query(
      "SELECT COUNT(*)::int AS c FROM password_resets WHERE user_id=$1 AND created_at > NOW() - INTERVAL '1 hour'", [u.id]);
    if (n.c >= 3) return res.json(SAME_ANSWER);

    const token = crypto.randomBytes(32).toString('base64url');
    await db.query(
      `INSERT INTO password_resets (user_id, token_hash, expires_at, ip) VALUES ($1,$2,NOW() + INTERVAL '30 minutes',$3)`,
      [u.id, hashToken(token), req.ip]);
    const base = email.baseUrl() || `${req.protocol}://${req.get('host')}`;
    const m = email.passwordResetEmail(u, `${base}/?reset=${token}`);
    const sent = await email.send({ ...m, to: u.email.trim(), kind: 'password_reset', user_id: u.id });
    note(res, { force: true, action: 'password_reset_request', entity: 'user', entity_id: u.id,
      user: { id: u.id, username: u.username, name: u.name, role: u.role },
      summary: sent.ok ? 'Asked for a password reset link (emailed)' : `Asked for a password reset link — email failed: ${sent.error}` });
    res.json(SAME_ANSWER);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// GET /api/auth/reset/:token — is this link still good? (shows whose account it is)
router.get('/reset/:token', async (req, res) => {
  const { rows: [r] } = await db.query(
    `SELECT u.username, u.name FROM password_resets p JOIN users u ON u.id = p.user_id
     WHERE p.token_hash=$1 AND p.used_at IS NULL AND p.expires_at > NOW() AND u.active`, [hashToken(req.params.token)]);
  if (!r) return res.status(400).json({ error: 'This reset link has expired or was already used. Ask for a new one.' });
  res.json(r);
});

// POST /api/auth/reset { token, password }
router.post('/reset', async (req, res) => {
  const { token, password } = req.body || {};
  if (!token) return res.status(400).json({ error: 'Missing reset link' });
  if (String(password || '').length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    const { rows: [p] } = await c.query(
      `SELECT p.id, u.id AS user_id, u.username, u.name, u.role FROM password_resets p JOIN users u ON u.id = p.user_id
       WHERE p.token_hash=$1 AND p.used_at IS NULL AND p.expires_at > NOW() AND u.active FOR UPDATE OF p`, [hashToken(token)]);
    if (!p) { await c.query('ROLLBACK'); return res.status(400).json({ error: 'This reset link has expired or was already used. Ask for a new one.' }); }
    await c.query('UPDATE users SET password=$1 WHERE id=$2', [await bcrypt.hash(String(password), 10), p.user_id]);
    await c.query('UPDATE password_resets SET used_at=NOW() WHERE user_id=$1 AND used_at IS NULL', [p.user_id]);
    await c.query('COMMIT');
    note(res, { action: 'password_reset', entity: 'user', entity_id: p.user_id,
      user: { id: p.user_id, username: p.username, name: p.name, role: p.role }, summary: 'Reset their password using an emailed link' });
    res.json({ ok: true, username: p.username });
  } catch (err) { await c.query('ROLLBACK').catch(() => {}); res.status(500).json({ error: err.message }); }
  finally { c.release(); }
});

module.exports = router;
