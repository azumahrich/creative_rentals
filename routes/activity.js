const router = require('express').Router();
const db     = require('../db');
const { requireAuth, requireSuperAdmin } = require('../middleware/auth');

// The activity log is for the Super Admin only. There are no routes to edit or delete it.
router.use(requireAuth, requireSuperAdmin);

// Groups shown in the "Type" filter
const GROUPS = {
  signins:   ['login', 'login_failed', 'password_change', 'emergency_reset'],
  failed:    ['login_failed'],
  rentals:   ['rental_create', 'booking_create', 'rental_pickup', 'rental_return', 'booking_cancel', 'rental_delete'],
  payments:  ['payment_create', 'payment_delete'],
  clients:   ['client_create', 'client_update', 'client_delete'],
  equipment: ['equipment_create', 'equipment_update', 'equipment_photo', 'equipment_delete'],
  expenses:  ['expense_create', 'expense_update', 'expense_delete'],
  users:     ['user_create', 'user_update', 'user_delete'],
  deletes:   ['rental_delete', 'payment_delete', 'client_delete', 'equipment_delete', 'user_delete', 'expense_delete', 'data_clear', 'booking_cancel'],
  system:    ['data_clear', 'data_import', 'emergency_reset', 'settings_update'],
};

/**
 * GET /api/activity?user_id=&type=&client_id=&from=&to=&q=&before_id=&limit=
 * Newest first. Use before_id (the last id you got) to load older entries.
 */
router.get('/', async (req, res) => {
  const { user_id, type, client_id, from, to, q, before_id } = req.query;
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 100, 1), 5000);
  const isDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
  const w = [], p = [];
  if (user_id)              { w.push(`user_id = $${p.push(user_id)}`); }
  if (type && GROUPS[type]) { w.push(`action = ANY($${p.push(GROUPS[type])})`); }
  if (client_id)            { w.push(`client_id = $${p.push(client_id)}`); }
  if (isDate(from))         { w.push(`at >= ($${p.push(from)}::date AT TIME ZONE 'Africa/Accra')`); }
  if (isDate(to))           { w.push(`at <  (($${p.push(to)}::date + 1) AT TIME ZONE 'Africa/Accra')`); }
  if (q)                    { w.push(`(summary ILIKE $${p.push('%' + q + '%')} OR username ILIKE $${p.length} OR user_name ILIKE $${p.length})`); }
  if (before_id)            { w.push(`id < $${p.push(before_id)}`); }
  try {
    const { rows } = await db.query(
      `SELECT id, at, user_id, username, user_name, role, action, entity, entity_id, client_id, summary, changes, ip, device
       FROM activity_log ${w.length ? 'WHERE ' + w.join(' AND ') : ''}
       ORDER BY id DESC LIMIT ${limit + 1}`, p);
    res.json({ items: rows.slice(0, limit), more: rows.length > limit });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/activity/stats — quick counts for the top of the Activity page
router.get('/stats', async (req, res) => {
  try {
    const { rows: [s] } = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE at >= date_trunc('day', NOW() AT TIME ZONE 'Africa/Accra') AT TIME ZONE 'Africa/Accra')::int AS today,
        COUNT(*) FILTER (WHERE action = 'login_failed' AND at >= NOW() - INTERVAL '7 days')::int AS failed_7d,
        COUNT(*) FILTER (WHERE action = ANY($1) AND at >= NOW() - INTERVAL '7 days')::int AS deletes_7d,
        COUNT(DISTINCT user_id) FILTER (WHERE action = 'login' AND at >= NOW() - INTERVAL '7 days')::int AS people_7d
      FROM activity_log`, [GROUPS.deletes]);
    res.json(s);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
