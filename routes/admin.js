const router = require('express').Router();
const bcrypt = require('bcryptjs');
const db     = require('../db');
const { requireAuth, requireSuperAdmin } = require('../middleware/auth');

// Clearing data is restricted to the Super Admin
router.use(requireAuth, requireSuperAdmin);

const WORDS = { equipment: 'EQUIPMENT', clients: 'CLIENTS', rentals: 'RENTALS', payments: 'PAYMENTS', all: 'EVERYTHING' };

// GET /api/admin/counts — numbers shown in the clear-data dialogs
router.get('/counts', async (req, res) => {
  try {
    const { rows: [c] } = await db.query(`
      SELECT
        (SELECT COUNT(*) FROM equipment WHERE NOT archived)::int AS equipment,
        (SELECT COUNT(*) FROM clients)::int  AS clients,
        (SELECT COUNT(*) FROM rentals)::int  AS rentals,
        (SELECT COUNT(*) FROM payments)::int AS payments,
        (SELECT COUNT(*) FROM rentals WHERE status IN ('active','overdue'))::int AS rentals_out`);
    res.json(c);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/**
 * POST /api/admin/clear
 * body: { target: 'equipment'|'clients'|'rentals'|'payments'|'all', confirm: 'EQUIPMENT'|..., password }
 * Requires the Super Admin role, the typed confirmation word, and their own password.
 */
router.post('/clear', async (req, res) => {
  const { target, confirm, password } = req.body || {};
  if (!WORDS[target]) return res.status(400).json({ error: 'Unknown target' });
  if (String(confirm || '').trim().toUpperCase() !== WORDS[target])
    return res.status(400).json({ error: `Type ${WORDS[target]} to confirm` });

  try {
    const { rows } = await db.query('SELECT password FROM users WHERE id=$1 AND active', [req.user.id]);
    if (!rows.length || !(await bcrypt.compare(password || '', rows[0].password)))
      return res.status(401).json({ error: 'Incorrect password' });
  } catch (err) { return res.status(500).json({ error: err.message }); }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    let result;

    if (target === 'payments') {
      const r = await client.query('DELETE FROM payments');
      await client.query('UPDATE rentals SET total_paid = 0');
      result = `${r.rowCount} payment(s) cleared`;

    } else if (target === 'rentals') {
      const rr = await client.query('DELETE FROM rentals');            // cascades to payments + rental_equipment
      await client.query('UPDATE equipment SET available = total');
      await client.query('DELETE FROM equipment WHERE archived');       // removed items no longer needed for history
      result = `${rr.rowCount} rental(s) and their payments cleared`;

    } else if (target === 'all') {
      const rr = await client.query('DELETE FROM rentals');
      const cr = await client.query('DELETE FROM clients');
      const er = await client.query('DELETE FROM equipment WHERE NOT archived');
      await client.query('DELETE FROM equipment');
      result = `Everything cleared: ${er.rowCount} equipment, ${cr.rowCount} client(s), ${rr.rowCount} rental(s) and their payments. User accounts were kept.`;

    } else if (target === 'clients') {
      // Every rental belongs to a client, so rentals (and their payments/items) go too
      const rr = await client.query('DELETE FROM rentals');           // cascades to payments + rental_equipment
      const cr = await client.query('DELETE FROM clients');
      await client.query('UPDATE equipment SET available = total');  // nothing is out any more
      result = `${cr.rowCount} client(s) and ${rr.rowCount} rental(s) cleared`;

    } else if (target === 'equipment') {
      const { rows: out } = await client.query(
        "SELECT COUNT(*)::int AS n FROM rentals WHERE status IN ('active','overdue')");
      if (out[0].n) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: `${out[0].n} rental(s) are still out. Mark them Returned first.` });
      }
      // Items used in past rentals are archived so old invoices keep their names; the rest are deleted
      const { rows: [live] } = await client.query(
        'SELECT COUNT(*)::int AS n FROM equipment WHERE NOT archived');
      await client.query(
        'DELETE FROM equipment WHERE id NOT IN (SELECT DISTINCT equipment_id FROM rental_equipment)');
      await client.query('UPDATE equipment SET archived = TRUE WHERE NOT archived');
      result = `${live.n} equipment item(s) cleared`;
    }

    await client.query('COMMIT');
    console.log(`[admin] ${req.user.username} cleared ${target}: ${result}`);
    res.json({ ok: true, message: result });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

/**
 * POST /api/admin/import
 * Loads a backup file exported from the OFFLINE Creative Rentals app.
 * body: { confirm: 'IMPORT', password, backup: { clients, rentals, equipment, exportedAt } }
 * REPLACES all equipment, clients, rentals and payments (user accounts are kept).
 * Runs in one transaction: if anything fails, nothing changes.
 */
const METHOD_MAP = { 'mobile money':'momo', 'momo':'momo', 'cash':'cash', 'bank transfer':'bank_transfer',
                     'bank_transfer':'bank_transfer', 'cheque':'cheque', 'check':'cheque' };
const STATUS_MAP = { active:'active', pending:'active', overdue:'overdue', returned:'returned', cancelled:'cancelled' };
const isDate = d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d);
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

router.post('/import', async (req, res) => {
  const { confirm, password, backup } = req.body || {};
  if (String(confirm || '').trim().toUpperCase() !== 'IMPORT')
    return res.status(400).json({ error: 'Type IMPORT to confirm' });
  if (!backup || !Array.isArray(backup.clients) || !Array.isArray(backup.rentals) || !Array.isArray(backup.equipment))
    return res.status(400).json({ error: 'This is not a Creative Rentals offline backup file (clients, rentals and equipment are missing).' });

  try {
    const { rows } = await db.query('SELECT password FROM users WHERE id=$1 AND active', [req.user.id]);
    if (!rows.length || !(await bcrypt.compare(password || '', rows[0].password)))
      return res.status(401).json({ error: 'Incorrect password' });
  } catch (err) { return res.status(500).json({ error: err.message }); }

  const client = await db.connect();
  const skipped = [];
  try {
    await client.query('BEGIN');
    // Start clean (users are kept)
    await client.query('DELETE FROM rentals');      // cascades to payments + rental_equipment
    await client.query('DELETE FROM clients');
    await client.query('DELETE FROM equipment');

    // ── Equipment ──
    const eqMap = new Map();                          // offline id → { id, price, deposit }
    const seenSerials = new Set();
    for (const e of backup.equipment) {
      if (!e || !e.name) continue;
      let serial = (e.serial || '').trim() || null;
      if (serial) { let s = serial, k = 2; while (seenSerials.has(s.toLowerCase())) s = `${serial}-${k++}`; serial = s; seenSerials.add(s.toLowerCase()); }
      const total = Math.max(1, Math.round(num(e.total) || 1));
      const avail = Math.min(total, Math.max(0, Math.round(num(e.avail ?? e.available ?? total))));
      const { rows: [row] } = await client.query(
        `INSERT INTO equipment (serial, name, category, price, deposit, available, total)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [serial, String(e.name).trim(), String(e.cat || e.category || 'Other').trim(), num(e.price), num(e.deposit), avail, total]);
      eqMap.set(String(e.id), { id: row.id, price: num(e.price), deposit: num(e.deposit) });
    }

    // ── Clients ──
    const clMap = new Map();                          // offline id → new id
    for (const c of backup.clients) {
      if (!c || !c.name) continue;
      const { rows: [row] } = await client.query(
        `INSERT INTO clients (name, phone, email, company, id_number, ghana_card, notes, joined)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [String(c.name).trim(), c.phone || null, c.email || null, c.company || null, c.idNumber || null,
         c.ghanaCard || null, c.notes || null, isDate(c.joined) ? c.joined.slice(0,10) : new Date().toISOString().slice(0,10)]);
      clMap.set(String(c.id), row.id);
    }

    // ── Rentals, their items and payments ──
    let rentalCount = 0, paymentCount = 0;
    for (const r of backup.rentals) {
      const clientId = r && clMap.get(String(r.clientId));
      if (!clientId || !isDate(r.start)) { skipped.push(`rental ${r && r.id || '?'} (client or date missing)`); continue; }
      const start = r.start.slice(0,10);
      const end = isDate(r.end) && r.end.slice(0,10) >= start ? r.end.slice(0,10) : start;
      const days = Math.max(1, Math.round(num(r.days) || 1));
      const status = STATUS_MAP[String(r.status || '').toLowerCase()] || 'active';
      const payments = Array.isArray(r.payments) ? r.payments.filter(p => p && num(p.amount) > 0) : [];
      const paidFromList = payments.reduce((s, p) => s + num(p.amount), 0);
      const totalPaid = payments.length ? paidFromList : num(r.paid);

      const { rows: [row] } = await client.query(
        `INSERT INTO rentals (client_id, start_date, end_date, days, status, subtotal, deposit_amt, total_paid, pickup_time, return_time, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [clientId, start, end, days, status, num(r.subtotal), num(r.deposit), totalPaid,
         r.pickupTime || '08:00', r.returnTime || '17:00',
         [r.notes, r.id ? `Imported from offline app (${r.id})` : null].filter(Boolean).join(' · ') || null]);
      rentalCount++;

      for (const oldEqId of (Array.isArray(r.equipment) ? r.equipment : [])) {
        const eq = eqMap.get(String(oldEqId));
        if (!eq) { skipped.push(`an item in rental ${r.id} (equipment no longer exists)`); continue; }
        await client.query(
          `INSERT INTO rental_equipment (rental_id, equipment_id, qty, unit_price, unit_deposit) VALUES ($1,$2,1,$3,$4)`,
          [row.id, eq.id, eq.price, eq.deposit]);
      }
      for (const p of payments) {
        const m = String(p.method || '').toLowerCase();
        const method = METHOD_MAP[m] || 'other';
        const note = [method === 'other' && p.method ? p.method : null, p.note].filter(Boolean).join(' · ') || null;
        await client.query(
          `INSERT INTO payments (rental_id, amount, method, reference, note, paid_at) VALUES ($1,$2,$3,$4,$5,$6)`,
          [row.id, num(p.amount), method, p.ref || p.reference || null, note,
           isDate(p.date) ? `${p.date.slice(0,10)} 12:00:00` : new Date().toISOString()]);
        paymentCount++;
      }
    }

    await client.query(
      "INSERT INTO app_meta (key, value) VALUES ('offline_import', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
      [new Date().toISOString()]);
    await client.query('COMMIT');

    const message = `Imported ${eqMap.size} equipment, ${clMap.size} client(s), ${rentalCount} rental(s) and ${paymentCount} payment(s).`
      + (skipped.length ? ` Skipped ${skipped.length}: ${skipped.slice(0,5).join('; ')}${skipped.length > 5 ? '…' : ''}` : '');
    console.log(`[admin] ${req.user.username} imported offline backup: ${message}`);
    res.json({ ok: true, message });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Import failed, nothing was changed: ' + err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
