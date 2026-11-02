/*
 * Date-aware availability.
 *
 * A unit is "taken" on a given day if it is on a rental that covers that day:
 *   - booked rentals:          start_date … end_date
 *   - active/overdue rentals:  start_date … end_date, or until TODAY if not yet returned
 *                              (an overdue item is still physically out)
 * Free on a date range = total − the busiest single day in that range.
 * For a range that starts today, it is also limited by what's physically in the shop now.
 */
const TODAY = `(NOW() AT TIME ZONE 'Africa/Accra')::date`;

const USAGE_SQL = `
  WITH days AS (SELECT generate_series($1::date, $2::date, interval '1 day')::date AS d),
  used AS (
    SELECT re.equipment_id, days.d, SUM(re.qty) AS q,
           array_agg(DISTINCT r.id) AS rental_ids
    FROM days
    JOIN rentals r ON r.status IN ('booked','active','overdue')
                  AND r.start_date <= days.d
                  AND (CASE WHEN r.status IN ('active','overdue')
                            THEN GREATEST(r.end_date, ${TODAY}) ELSE r.end_date END) >= days.d
                  AND ($3::int IS NULL OR r.id <> $3::int)
    JOIN rental_equipment re ON re.rental_id = r.id
    GROUP BY re.equipment_id, days.d
  ),
  peak AS (
    SELECT DISTINCT ON (equipment_id) equipment_id, d AS busiest_day, q AS peak, rental_ids
    FROM used ORDER BY equipment_id, q DESC, d
  )
  SELECT e.id, e.name, e.total, e.available,
         COALESCE(p.peak, 0)::int AS peak, p.busiest_day, p.rental_ids
  FROM equipment e
  LEFT JOIN peak p ON p.equipment_id = e.id
  WHERE NOT e.archived`;

/**
 * Returns Map(equipment_id → { id, name, total, available, free, busiest_day, rental_ids })
 * q = db or a transaction client. excludeRentalId lets a rental ignore itself.
 */
async function availabilityFor(q, from, to, excludeRentalId = null) {
  const { rows: [{ today }] } = await q.query(`SELECT ${TODAY}::text AS today`);
  const { rows } = await q.query(USAGE_SQL, [from, to, excludeRentalId]);
  const map = new Map();
  for (const r of rows) {
    let free = r.total - r.peak;
    if (from <= today) free = Math.min(free, r.available);   // can't hand out what isn't in the shop
    map.set(r.id, { ...r, free: Math.max(0, free) });
  }
  return { map, today };
}

module.exports = { availabilityFor, TODAY };
