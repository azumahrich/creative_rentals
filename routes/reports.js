const router = require('express').Router();
const db     = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');

router.use(requireAuth);

/**
 * GET /api/reports/summary
 * Query params: from, to, client_id, equipment_id
 */
router.get('/summary', requireAdmin, async (req, res) => {
  const { from, to, client_id, equipment_id } = req.query;
  const isDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
  if ((from && !isDate(from)) || (to && !isDate(to))) return res.status(400).json({ error: 'Dates must be YYYY-MM-DD' });

  // A rental is in the report if any of its days fall inside the From–To range
  // (so multi-day rentals and advance bookings are included, not just ones that have ended)
  const where  = ['1=1'];
  const params = [];
  let i = 1;
  if (to)           { where.push(`r.start_date <= $${i++}`); params.push(to); }
  if (from)         { where.push(`r.end_date   >= $${i++}`); params.push(from); }
  if (client_id)    { where.push(`r.client_id   = $${i++}`); params.push(client_id); }
  if (equipment_id) {
    where.push(`EXISTS (SELECT 1 FROM rental_equipment re2 WHERE re2.rental_id=r.id AND re2.equipment_id=$${i++})`);
    params.push(equipment_id);
  }
  const cond = where.join(' AND ');
  const live = `${cond} AND r.status <> 'cancelled'`;   // cancelled bookings don't count as business

  try {
    const { rows: [agg] } = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE status <> 'cancelled')  AS total_rentals,
        COUNT(*) FILTER (WHERE status='active')    AS active_rentals,
        COUNT(*) FILTER (WHERE status='returned')  AS returned_rentals,
        COUNT(*) FILTER (WHERE status='overdue')   AS overdue_rentals,
        COUNT(*) FILTER (WHERE status='booked')    AS booked_rentals,
        COUNT(*) FILTER (WHERE status='cancelled') AS cancelled_rentals,
        COALESCE(SUM(subtotal)    FILTER (WHERE status <> 'cancelled'),0) AS gross_revenue,
        COALESCE(SUM(deposit_amt) FILTER (WHERE status <> 'cancelled'),0) AS deposits,
        COALESCE(SUM(total_paid),0)                                       AS collected,
        COALESCE(SUM(subtotal + deposit_amt - total_paid) FILTER (WHERE status <> 'cancelled'),0) AS outstanding
      FROM rentals r WHERE ${cond}`, params);

    // Every rental in range
    const { rows: rentals } = await db.query(`
      SELECT r.id, r.start_date, r.end_date, r.days, r.status,
             r.subtotal, r.deposit_amt, r.total_paid,
             c.name AS client_name, c.ghana_card, c.phone,
             (SELECT string_agg(CASE WHEN re.qty > 1 THEN re.qty || ' × ' || e.name ELSE e.name END, ', ' ORDER BY e.name)
                FROM rental_equipment re JOIN equipment e ON e.id = re.equipment_id WHERE re.rental_id = r.id) AS items
      FROM rentals r JOIN clients c ON c.id = r.client_id
      WHERE ${cond}
      ORDER BY r.start_date DESC, r.id DESC`, params);

    // EVERY client, with their totals for the range (clients with no rentals show zeros)
    const { rows: by_client } = await db.query(`
      SELECT c.id, c.name, c.phone, c.ghana_card,
             COUNT(r.id)::int                          AS rentals,
             COALESCE(SUM(r.days),0)::int              AS days,
             COALESCE(SUM(r.subtotal),0)               AS revenue,
             COALESCE(SUM(r.total_paid),0)             AS paid,
             COALESCE(SUM(r.subtotal + r.deposit_amt - r.total_paid),0) AS outstanding,
             MAX(r.start_date)                         AS last_rental
      FROM clients c
      LEFT JOIN rentals r ON r.client_id = c.id AND ${live}
      ${client_id ? `WHERE c.id = $${params.indexOf(client_id) + 1}` : ''}
      GROUP BY c.id
      ORDER BY revenue DESC, rentals DESC, c.name`, params);

    // EVERY equipment item, with its usage for the range (never-rented items show zeros)
    const { rows: by_equipment } = await db.query(`
      WITH usage AS (
        SELECT re.equipment_id,
               COUNT(DISTINCT r.id)::int            AS times_rented,
               SUM(re.qty)::int                     AS units,
               SUM(re.qty * r.days)::int            AS unit_days,
               SUM(re.unit_price * re.qty * r.days) AS revenue,
               MAX(r.start_date)                    AS last_rented
        FROM rental_equipment re JOIN rentals r ON r.id = re.rental_id
        WHERE ${live}
        GROUP BY re.equipment_id)
      SELECT e.id, e.name, e.serial, e.category, e.total, e.available, e.archived,
             (p.equipment_id IS NOT NULL) AS has_photo,
             COALESCE(FLOOR(EXTRACT(EPOCH FROM p.updated_at))::bigint, 0) AS photo_v,
             COALESCE(u.times_rented,0) AS times_rented, COALESCE(u.units,0) AS units,
             COALESCE(u.unit_days,0)    AS unit_days,    COALESCE(u.revenue,0) AS revenue, u.last_rented
      FROM equipment e LEFT JOIN usage u ON u.equipment_id = e.id
      LEFT JOIN equipment_photos p ON p.equipment_id = e.id
      WHERE (NOT e.archived OR u.equipment_id IS NOT NULL)
        ${equipment_id ? `AND e.id = $${params.indexOf(equipment_id) + 1}` : ''}
      ORDER BY revenue DESC, times_rented DESC, e.category, e.name`, params);

    res.json({ summary: agg, rentals, by_client, by_equipment });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/reports/dashboard
 * Quick stats for the dashboard home page
 */
router.get('/dashboard', async (req, res) => {
  try {
    await db.query(require('./rentals').OVERDUE_SQL);
    const { rows: [stats] } = await db.query(`
      SELECT
        (SELECT COUNT(*) FROM clients)                         AS total_clients,
        (SELECT COUNT(*) FROM equipment WHERE NOT archived)   AS total_equipment,
        (SELECT COUNT(*) FROM rentals WHERE status='active')   AS active_rentals,
        (SELECT COUNT(*) FROM rentals WHERE status='overdue')  AS overdue_rentals,
        (SELECT COUNT(*) FROM rentals WHERE status='booked')   AS booked_rentals,
        (SELECT COUNT(*) FROM rentals WHERE status='booked'
           AND start_date <= (NOW() AT TIME ZONE 'Africa/Accra')::date
           AND end_date   >= (NOW() AT TIME ZONE 'Africa/Accra')::date) AS pickups_today,
        (SELECT COALESCE(SUM(amount),0) FROM payments
         WHERE paid_at >= date_trunc('month', CURRENT_DATE)) AS month_revenue,
        (SELECT COALESCE(SUM(subtotal+deposit_amt-total_paid),0) FROM rentals
         WHERE status IN ('active','overdue'))                  AS outstanding
    `);
    // Staff don't see money totals on the dashboard
    if (!['admin','superadmin'].includes(req.user.role)) { delete stats.month_revenue; delete stats.outstanding; }
    res.json(stats);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
