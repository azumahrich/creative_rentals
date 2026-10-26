require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');

const app = express();

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
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
setupDatabase()
  .then(() => app.listen(PORT, () => console.log(`Creative Rentals running on http://localhost:${PORT}`)))
  .catch(err => { console.error('Database setup failed:', err.message); process.exit(1); });
