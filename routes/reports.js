const router = require('express').Router();
const db     = require('../db');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

/**
 * GET /api/reports/summary
 * Query params: from, to, client_id, equipment_id
 */
router.get('/summary', async (req, res) => {
  const { from, to, client_id, equipment_id } = req.query;

  const where  = ['1=1'];
  const params = [];
  let i = 1;

  if (from)         { where.push(`r.start_date >= $${i++}`); params.push(from); }
  if (to)           { where.push(`r.end_date   <= $${i++}`); params.push(to); }
  if (client_id)    { where.push(`r.client_id   = $${i++}`); params.push(client_id); }
  if (equipment_id) {
    where.push(`EXISTS (SELECT 1 FROM rental_equipment re WHERE re.rental_id=r.id AND re.equipment_id=$${i++})`);
    params.push(equipment_id);
  }

  const cond = where.join(' AND ');

  try {
    // Aggregates
    const { rows: [agg] } = await db.query(`
      SELECT
        COUNT(*)                               AS total_rentals,
        COUNT(*) FILTER (WHERE status='active')   AS active_rentals,
        COUNT(*) FILTER (WHERE status='returned') AS returned_rentals,
        COUNT(*) FILTER (WHERE status='overdue')  AS overdue_rentals,
        COALESCE(SUM(subtotal),0)              AS gross_revenue,
        COALESCE(SUM(total_paid),0)            AS collected,
        COALESCE(SUM(subtotal + deposit_amt - total_paid),0) AS outstanding
      FROM rentals r
      WHERE ${cond}
    `, params);

    // Rental list
    const { rows: rentals } = await db.query(`
      SELECT r.id, r.start_date, r.end_date, r.days, r.status,
             r.subtotal, r.deposit_amt, r.total_paid,
             c.name AS client_name, c.ghana_card
      FROM rentals r
      JOIN clients c ON c.id = r.client_id
      WHERE ${cond}
      ORDER BY r.start_date DESC
      LIMIT 500
    `, params);

    // Equipment usage
    const { rows: equipment } = await db.query(`
      SELECT e.name, e.serial, e.category,
             COUNT(re.id)     AS times_rented,
             SUM(re.qty)      AS total_qty,
             SUM(re.unit_price * re.qty * r.days) AS revenue
      FROM rental_equipment re
      JOIN equipment e ON e.id = re.equipment_id
      JOIN rentals r   ON r.id = re.rental_id
      WHERE ${cond}
      GROUP BY e.id
      ORDER BY revenue DESC
      LIMIT 20
    `, params);

    res.json({ summary: agg, rentals, equipment });
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
        (SELECT COALESCE(SUM(amount),0) FROM payments
         WHERE paid_at >= date_trunc('month', CURRENT_DATE)) AS month_revenue,
        (SELECT COALESCE(SUM(subtotal+deposit_amt-total_paid),0) FROM rentals
         WHERE status IN ('active','overdue'))                  AS outstanding
    `);
    res.json(stats);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
