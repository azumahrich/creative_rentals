-- Creative Rentals — PostgreSQL schema
-- Run once: psql -d creative_rentals -f db/schema.sql

-- ─── Extensions ──────────────────────────────────────────────────────────────

-- ─── Users ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id          SERIAL PRIMARY KEY,
  username    TEXT UNIQUE NOT NULL,
  password    TEXT NOT NULL,             -- bcrypt hash
  name        TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'staff',
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Default admin user is created automatically by server.js on first start

-- Roles: superadmin (controls admins & users) > admin (manages staff) > staff
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('superadmin','admin','staff'));
-- Upgrade older databases: the first admin account becomes the Super Admin
UPDATE users SET role = 'superadmin'
WHERE id = (SELECT MIN(id) FROM users WHERE role = 'admin')
  AND NOT EXISTS (SELECT 1 FROM users WHERE role = 'superadmin');

-- ─── Clients ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS clients (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  phone       TEXT,
  email       TEXT,
  company     TEXT,
  id_number   TEXT,
  ghana_card  TEXT,
  notes       TEXT,
  joined      DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Equipment ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS equipment (
  id          SERIAL PRIMARY KEY,
  serial      TEXT,
  name        TEXT NOT NULL,
  category    TEXT NOT NULL,
  price       NUMERIC(12,2) NOT NULL DEFAULT 0,
  deposit     NUMERIC(12,2) NOT NULL DEFAULT 0,
  available   INTEGER NOT NULL DEFAULT 1,
  total       INTEGER NOT NULL DEFAULT 1,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Removed items are archived (hidden) so past invoices & reports keep their details
ALTER TABLE equipment ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE equipment DROP CONSTRAINT IF EXISTS equipment_serial_key;
CREATE UNIQUE INDEX IF NOT EXISTS equipment_serial_live ON equipment(serial) WHERE NOT archived;

-- One-time flags (e.g. so equipment is only seeded on the very first start,
-- and never comes back after an admin clears it)
CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT);

-- Seed equipment (first start only)
INSERT INTO equipment (serial, name, category, price, deposit, available, total)
SELECT * FROM (VALUES
  ('SN-CR001', 'Sony A7 IV Body', 'Camera', 45, 300, 4, 4),
  ('SN-CR002', 'Canon EOS R5', 'Camera', 55, 400, 2, 2),
  ('SN-CR003', 'Nikon Z9 Body', 'Camera', 65, 450, 2, 2),
  ('SN-CR004', 'Fujifilm GFX 100S', 'Camera', 80, 600, 1, 1),
  ('SN-CR005', 'DJI Ronin 4D', 'Cinema Camera', 120, 800, 2, 2),
  ('SN-CR006', 'Sony FX3', 'Cinema Camera', 95, 600, 1, 1),
  ('SN-CR007', 'Blackmagic URSA Mini 12K', 'Cinema Camera', 110, 750, 1, 1),
  ('SN-CR008', 'Canon 24-70mm f/2.8L', 'Lens', 25, 150, 5, 5),
  ('SN-CR009', 'Sony 85mm f/1.4 GM', 'Lens', 20, 120, 3, 3),
  ('SN-CR010', 'Sigma 35mm f/1.4 Art', 'Lens', 15, 90, 3, 3),
  ('SN-CR011', 'Canon 70-200mm f/2.8L', 'Lens', 28, 160, 2, 2),
  ('SN-CR012', 'Laowa 12mm f/2.8 Zero-D', 'Lens', 18, 100, 2, 2),
  ('SN-CR013', 'DJI Mavic 3 Pro', 'Drone', 60, 500, 2, 2),
  ('SN-CR014', 'DJI Air 3', 'Drone', 40, 350, 1, 1),
  ('SN-CR015', 'Godox SL200W LED', 'Lighting', 15, 80, 6, 6),
  ('SN-CR016', 'Profoto B10 Plus', 'Lighting', 30, 200, 4, 4),
  ('SN-CR017', 'Aputure 600d Pro', 'Lighting', 35, 220, 2, 2),
  ('SN-CR018', 'Nanlite Forza 500B', 'Lighting', 22, 130, 3, 3),
  ('SN-CR019', 'Sennheiser MKH 416', 'Audio', 18, 100, 3, 3),
  ('SN-CR020', 'Zoom H6 Recorder', 'Audio', 12, 60, 4, 4),
  ('SN-CR021', 'Rode NTG5 Shotgun', 'Audio', 16, 90, 3, 3),
  ('SN-CR022', 'Sound Devices MixPre-6', 'Audio', 25, 140, 2, 2),
  ('SN-CR023', 'GlideCam XR-4000', 'Stabilizer', 22, 120, 2, 2),
  ('SN-CR024', 'DJI RS 3 Pro', 'Stabilizer', 28, 150, 2, 2),
  ('SN-CR025', 'Movi Pro Gimbal', 'Stabilizer', 35, 200, 1, 1),
  ('SN-CR026', 'Atomos Shogun 7', 'Monitor/Recorder', 20, 120, 3, 3),
  ('SN-CR027', 'SmallHD 702 Touch', 'Monitor/Recorder', 15, 90, 4, 4),
  ('SN-CR028', 'Pelican 1510 Case', 'Accessories', 8, 40, 6, 6),
  ('SN-CR029', 'V-Mount Battery Kit', 'Accessories', 10, 50, 5, 5),
  ('SN-CR030', 'C-Stand Kit (5pc)', 'Accessories', 12, 60, 4, 4)
) AS v(serial,name,category,price,deposit,available,total)
WHERE NOT EXISTS (SELECT 1 FROM equipment)
  AND NOT EXISTS (SELECT 1 FROM app_meta WHERE key = 'equipment_seeded');
INSERT INTO app_meta (key, value) VALUES ('equipment_seeded', NOW()::text) ON CONFLICT (key) DO NOTHING;

-- ─── Rentals ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rentals (
  id           SERIAL PRIMARY KEY,
  client_id    INTEGER NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  start_date   DATE NOT NULL,
  end_date     DATE NOT NULL,
  days         INTEGER NOT NULL DEFAULT 1,
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','returned','overdue','cancelled')),
  subtotal     NUMERIC(12,2) NOT NULL DEFAULT 0,
  deposit_amt  NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_paid   NUMERIC(12,2) NOT NULL DEFAULT 0,
  pickup_time  TEXT,
  return_time  TEXT,
  notes        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Rental Equipment (junction) ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rental_equipment (
  id           SERIAL PRIMARY KEY,
  rental_id    INTEGER NOT NULL REFERENCES rentals(id) ON DELETE CASCADE,
  equipment_id INTEGER NOT NULL REFERENCES equipment(id) ON DELETE RESTRICT,
  qty          INTEGER NOT NULL DEFAULT 1,
  unit_price   NUMERIC(12,2) NOT NULL DEFAULT 0,
  unit_deposit NUMERIC(12,2) NOT NULL DEFAULT 0
);

-- ─── Payments ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payments (
  id          SERIAL PRIMARY KEY,
  rental_id   INTEGER NOT NULL REFERENCES rentals(id) ON DELETE CASCADE,
  amount      NUMERIC(12,2) NOT NULL,
  method      TEXT NOT NULL DEFAULT 'cash' CHECK (method IN ('cash','momo','bank_transfer','cheque','other')),
  reference   TEXT,
  note        TEXT,
  paid_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Indexes ─────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_rentals_client   ON rentals(client_id);
CREATE INDEX IF NOT EXISTS idx_rentals_status   ON rentals(status);
CREATE INDEX IF NOT EXISTS idx_rentals_dates    ON rentals(start_date, end_date);
CREATE INDEX IF NOT EXISTS idx_re_rental        ON rental_equipment(rental_id);
CREATE INDEX IF NOT EXISTS idx_payments_rental  ON payments(rental_id);
