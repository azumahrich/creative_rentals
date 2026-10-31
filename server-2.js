require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');

const app = express();

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '20mb' }));   // large enough for backup imports
app.use(express.urlencoded({ extended: true }));

// ─── API Routes ───────────────────────────────────────────────────────────────
app.use('/api/auth',      require('./routes/auth'));
app.use('/api/users',     require('./routes/users'));
app.use('/api/clients',   require('./routes/clients'));
app.use('/api/equipment', require('./routes/equipment'));
app.use('/api/rentals',   require('./routes/rentals'));
app.use('/api/payments',  require('./routes/payments'));
app.use('/api/reports',   require('./routes/reports'));
app.use('/api/admin',     require('./routes/admin'));

// ─── Serve Frontend ───────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
// SPA catch-all — every non-API route returns index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start ────────────────────────────────────────────────────────────────────
const fs     = require('fs');
const bcrypt = require('bcryptjs');
const db     = require('./db');

async function setupDatabase() {
  // Create tables + seed equipment (safe to run every boot)
  await db.query(fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8'));
  // Create default admin if there are no users yet
  const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM users');
  if (rows[0].n === 0) {
    const hash = await bcrypt.hash('admin123', 10);
    await db.query(
      "INSERT INTO users (username, password, name, role) VALUES ('admin',$1,'Super Admin','superadmin')", [hash]
    );
    console.log('Default Super Admin created — username: admin / password: admin123 (change it!)');
  }
}

const PORT = process.env.PORT || 3000;

// Explain database problems in plain words instead of a blank error
function describeDbError(err) {
  const parts = [err.message, err.code, ...(err.errors || []).map(e => e.message || e.code)].filter(Boolean);
  const text = parts.join(' | ') || String(err);
  let hint = '';
  if (/ECONNREFUSED.*(127\.0\.0\.1|::1)/.test(text) || /localhost/.test(text))
    hint = 'The app is trying to use a database on its own machine, so DATABASE_URL is probably missing or misspelt.';
  else if (/ENOTFOUND|EAI_AGAIN/.test(text))
    hint = 'The database address in DATABASE_URL could not be found. If you used the Internal Database URL, make sure the database and web service are in the SAME region, or use the External Database URL.';
  else if (/password authentication failed/i.test(text))
    hint = 'The username or password inside DATABASE_URL is wrong. Copy the URL again from the database Info page.';
  else if (/does not exist/i.test(text))
    hint = 'The database name at the end of DATABASE_URL is wrong. Copy the URL again from the database Info page.';
  else if (/timeout/i.test(text))
    hint = 'The database did not answer in time. Check it shows "Available" in Render, and that the regions match.';
  return text + (hint ? '\n  → ' + hint : '');
}

if (!process.env.DATABASE_URL) {
  console.error('Database setup failed: the DATABASE_URL setting is missing.');
  console.error('  → In Render, open this web service → Environment → add DATABASE_URL (the Internal Database URL), then Save and redeploy.');
  process.exit(1);
}
try {
  const u = new URL(process.env.DATABASE_URL.trim());
  console.log(`Connecting to database "${u.pathname.slice(1)}" at ${u.hostname}…`);
} catch {
  console.error('Database setup failed: DATABASE_URL is not a valid address. It should start with postgresql:// — copy it again from the database Info page.');
  process.exit(1);
}

/*
 * Emergency Super Admin password reset (for when the Super Admin is locked out).
 * In Render → web service → Environment, add:
 *   RESET_SUPERADMIN_PASSWORD = the new password (at least 8 characters)
 *   RESET_SUPERADMIN_USERNAME = (optional) whose account; default = the first Super Admin
 * Save → the app restarts and applies it once. Then DELETE the variable(s).
 * The same value is never applied twice, so leaving it set can't undo a later password change.
 */
async function emergencySuperAdminReset() {
  const newPw = (process.env.RESET_SUPERADMIN_PASSWORD || '').trim();
  if (!newPw) return;
  if (newPw.length < 8) { console.error('[recovery] RESET_SUPERADMIN_PASSWORD must be at least 8 characters — not applied.'); return; }
  const wantUser = (process.env.RESET_SUPERADMIN_USERNAME || '').trim().toLowerCase();
  const crypto = require('crypto');
  const fingerprint = crypto.createHash('sha256').update(wantUser + '|' + newPw).digest('hex');
  const { rows: done } = await db.query("SELECT value FROM app_meta WHERE key='superadmin_reset'");
  if (done.length && done[0].value === fingerprint) {
    console.log('[recovery] This reset was already applied. Remove RESET_SUPERADMIN_PASSWORD from the Environment settings.');
    return;
  }
  const hash = await bcrypt.hash(newPw, 10);
  let target;
  if (wantUser) {
    ({ rows: [target] } = await db.query('SELECT id, username FROM users WHERE username=$1', [wantUser]));
    if (!target) { console.error(`[recovery] No user called "${wantUser}" — not applied.`); return; }
  } else {
    ({ rows: [target] } = await db.query("SELECT id, username FROM users WHERE role='superadmin' ORDER BY id LIMIT 1"));
  }
  if (target) {
    await db.query("UPDATE users SET password=$1, role='superadmin', active=TRUE WHERE id=$2", [hash, target.id]);
  } else {
    ({ rows: [target] } = await db.query(
      "INSERT INTO users (username, password, name, role) VALUES ('admin',$1,'Super Admin','superadmin') " +
      "ON CONFLICT (username) DO UPDATE SET password=EXCLUDED.password, role='superadmin', active=TRUE RETURNING id, username", [hash]));
  }
  await db.query(
    "INSERT INTO app_meta (key, value) VALUES ('superadmin_reset', $1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", [fingerprint]);
  console.log(`[recovery] Password reset for Super Admin "${target.username}". Log in now, then REMOVE RESET_SUPERADMIN_PASSWORD from the Environment settings.`);
}

setupDatabase()
  .then(emergencySuperAdminReset)
  .then(() => app.listen(PORT, () => console.log(`Creative Rentals running on port ${PORT}`)))
  .catch(err => { console.error('Database setup failed: ' + describeDbError(err)); process.exit(1); });
