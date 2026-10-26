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

module.exports = router;
