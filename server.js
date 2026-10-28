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

setupDatabase()
  .then(() => app.listen(PORT, () => console.log(`Creative Rentals running on port ${PORT}`)))
  .catch(err => { console.error('Database setup failed: ' + describeDbError(err)); process.exit(1); });
