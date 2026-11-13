/*
 * Automatic emails — runs inside the web service once a minute.
 *
 *   Return reminder  → 2 hours before the return time on the return day (5:00 PM for a 7:00 PM return).
 *                      Not sent for rentals made less than 3 hours before the return time.
 *   Overdue notice   → once when a rental becomes overdue, then each morning from 9:00 AM,
 *                      at most 3 notices, and only for rentals due in the last 3 days
 *                      (so old, forgotten rentals don't suddenly get emails).
 *   Daily summary    → to the Super Admin at the time set in Settings (default 7:30 PM).
 *
 * Times are Ghana time. Each email has a dedupe key, so nothing is sent twice,
 * even if the app restarts or Render runs two copies for a moment during a deploy.
 */
const db = require('../db');
const email = require('./email');

const MAX_FAILS = 3;
const OVERDUE_SQL = `UPDATE rentals SET status='overdue'
  WHERE status='active' AND (end_date + CASE WHEN return_time ~ '^\\s*\\d{1,2}:\\d{2}' THEN return_time::time ELSE TIME '19:00' END)
        < (NOW() AT TIME ZONE 'Africa/Accra')`;
const RET_TS = `(r.end_date + CASE WHEN r.return_time ~ '^\\s*\\d{1,2}:\\d{2}' THEN r.return_time::time ELSE TIME '19:00' END)`;
const NOW_GH = `(NOW() AT TIME ZONE 'Africa/Accra')`;

async function loadRental(id, q = db) {
  const { rows: [r] } = await q.query(
    `SELECT r.*, c.name AS client_name, c.phone AS client_phone, c.email AS client_email
     FROM rentals r JOIN clients c ON c.id = r.client_id WHERE r.id=$1`, [id]);
  if (!r) return null;
  const { rows: equipment } = await q.query(
    `SELECT re.qty, re.unit_price, re.unit_deposit, e.name, e.serial
     FROM rental_equipment re JOIN equipment e ON e.id = re.equipment_id WHERE re.rental_id=$1 ORDER BY re.id`, [id]);
  const { rows: payments } = await q.query('SELECT * FROM payments WHERE rental_id=$1 ORDER BY paid_at', [id]);
  return { ...r, equipment, payments };
}

// Has this automatic email already failed too many times?
async function gaveUp(key) {
  const { rows: [x] } = await db.query("SELECT COUNT(*)::int AS n FROM email_log WHERE dedupe_key LIKE $1", [key + ':fail:%']);
  return x.n >= MAX_FAILS;
}
async function alreadySent(key) {
  const { rows } = await db.query('SELECT 1 FROM email_log WHERE dedupe_key=$1', [key]);
  return rows.length > 0;
}
async function sendOnce(key, build) {
  if (await alreadySent(key) || await gaveUp(key)) return null;
  const opts = await build();
  return opts ? email.send({ ...opts, dedupe_key: key }) : null;
}

async function returnReminders() {
  const { rows } = await db.query(
    `SELECT r.id FROM rentals r JOIN clients c ON c.id = r.client_id
     WHERE r.status = 'active' AND r.end_date = ${NOW_GH}::date
       AND COALESCE(c.email,'') <> ''
       AND ${NOW_GH} >= ${RET_TS} - INTERVAL '2 hours' AND ${NOW_GH} < ${RET_TS}
       AND (r.created_at AT TIME ZONE 'Africa/Accra') < ${RET_TS} - INTERVAL '3 hours'`);
  for (const { id } of rows) {
    const r = await loadRental(id);
    await sendOnce(`return:${id}:${r.end_date}`, () => ({ ...email.returnReminderEmail(r), to: r.client_email,
      kind: 'return_reminder', rental_id: id, client_id: r.client_id }));
  }
}

async function overdueNotices(today, hm) {
  const { rows } = await db.query(
    `SELECT r.id, r.end_date, (${NOW_GH}::date - r.end_date) AS late_days,
            (SELECT COUNT(*)::int FROM email_log l WHERE l.rental_id = r.id AND l.kind='overdue' AND l.status='sent') AS sent
     FROM rentals r JOIN clients c ON c.id = r.client_id
     WHERE r.status = 'overdue' AND COALESCE(c.email,'') <> ''
       AND r.end_date >= ${NOW_GH}::date - 3`);
  for (const x of rows) {
    if (x.sent >= 3) continue;
    if (x.late_days > 0 && hm < '09:00') continue;          // later notices go out in the morning
    const r = await loadRental(x.id);
    await sendOnce(`overdue:${x.id}:${today}`, () => ({ ...email.overdueEmail(r, x.late_days), to: r.client_email,
      kind: 'overdue', rental_id: x.id, client_id: r.client_id }));
  }
}

async function summaryRecipients(settings) {
  const listed = email.splitEmails(settings.summary_to).filter(email.isEmail);
  if (listed.length) return listed;
  const { rows } = await db.query("SELECT email FROM users WHERE role='superadmin' AND active AND COALESCE(email,'') <> ''");
  return rows.map(r => r.email.trim()).filter(email.isEmail);
}

// ─── Daily summary ───────────────────────────────────────────────────────────
async function buildSummary(day) {
  const { esc, ghc, ref, fmtDate, fmtTime, TH, THR, TD, TDR } = email;
  const one = async (sql, p = [day]) => (await db.query(sql, p)).rows[0];
  const many = async (sql, p = [day]) => (await db.query(sql, p)).rows;
  const localDate = col => `(${col} AT TIME ZONE 'Africa/Accra')::date`;

  const made = await one(`SELECT
      COUNT(*) FILTER (WHERE status <> 'booked')::int AS rentals, COALESCE(SUM(subtotal) FILTER (WHERE status <> 'booked'),0) AS rental_value,
      COUNT(*) FILTER (WHERE status = 'booked')::int AS bookings,  COALESCE(SUM(subtotal) FILTER (WHERE status = 'booked'),0) AS booking_value,
      COALESCE(SUM(discount_amt),0) AS discounts
    FROM rentals WHERE ${localDate('created_at')} = $1 AND status <> 'cancelled'`);
  const wentOut = await one(`SELECT COUNT(*)::int AS n FROM rentals WHERE start_date = $1 AND status IN ('active','overdue','returned')`);
  const returned = await one(`SELECT COUNT(*)::int AS n FROM activity_log WHERE action='rental_return' AND ${localDate('at')} = $1`);
  const pays = await many(`SELECT p.method, COUNT(*)::int AS n, SUM(p.amount) AS total FROM payments p JOIN rentals r ON r.id = p.rental_id
    WHERE r.status <> 'cancelled' AND ${localDate('p.paid_at')} = $1 GROUP BY p.method ORDER BY 3 DESC`);
  const exps = await many(`SELECT category, COUNT(*)::int AS n, SUM(amount) AS total FROM expenses WHERE spent_on = $1 GROUP BY category ORDER BY 3 DESC`);
  const month = await one(`SELECT
      (SELECT COALESCE(SUM(p.amount),0) FROM payments p JOIN rentals r ON r.id = p.rental_id WHERE r.status <> 'cancelled' AND ${localDate('p.paid_at')} BETWEEN date_trunc('month',$1::date)::date AND $1) AS received,
      (SELECT COALESCE(SUM(subtotal),0) FROM rentals WHERE status <> 'cancelled' AND start_date BETWEEN date_trunc('month',$1::date)::date AND $1) AS revenue,
      (SELECT COALESCE(SUM(amount),0) FROM expenses WHERE spent_on BETWEEN date_trunc('month',$1::date)::date AND $1) AS expenses`);
  const out = await one(`SELECT COUNT(*) FILTER (WHERE status='active')::int AS active, COUNT(*) FILTER (WHERE status='overdue')::int AS overdue FROM rentals WHERE $1::date IS NOT NULL`);
  const overdue = await many(`SELECT r.id, r.end_date, r.return_time, c.name, c.phone, (r.subtotal + r.deposit_amt - r.total_paid) AS balance,
      (SELECT string_agg(CASE WHEN re.qty>1 THEN re.qty||' × '||e.name ELSE e.name END, ', ') FROM rental_equipment re JOIN equipment e ON e.id=re.equipment_id WHERE re.rental_id=r.id) AS items
    FROM rentals r JOIN clients c ON c.id=r.client_id WHERE r.status='overdue' AND $1::date IS NOT NULL ORDER BY r.end_date LIMIT 30`);
  const tomorrow = await many(`SELECT r.id, r.status, r.start_date, r.end_date, r.pickup_time, r.return_time, c.name,
      (SELECT string_agg(CASE WHEN re.qty>1 THEN re.qty||' × '||e.name ELSE e.name END, ', ') FROM rental_equipment re JOIN equipment e ON e.id=re.equipment_id WHERE re.rental_id=r.id) AS items
    FROM rentals r JOIN clients c ON c.id=r.client_id
    WHERE (r.status='booked' AND r.start_date = $1::date + 1) OR (r.status='active' AND r.end_date = $1::date + 1)
    ORDER BY r.status DESC, r.pickup_time`);
  const failed = await one(`SELECT COUNT(*)::int AS n FROM activity_log WHERE action='login_failed' AND ${localDate('at')} = $1`);
  const deletes = await one(`SELECT COUNT(*)::int AS n FROM activity_log WHERE action LIKE '%delete%' AND ${localDate('at')} = $1`);

  const received = pays.reduce((s, p) => s + +p.total, 0), spent = exps.reduce((s, e) => s + +e.total, 0);
  const card = (label, value, color = '#1d1d1f') => `<td width="33%" style="padding:6px"><div style="background:#faf8f6;border-radius:8px;padding:10px">
      <div style="font-size:11px;color:#888">${label}</div><div style="font-size:17px;font-weight:700;color:${color}">${value}</div></div></td>`;
  const h3 = t => `<h3 style="margin:20px 0 6px;font-size:14px;color:#E8520A;text-transform:uppercase;letter-spacing:.04em">${t}</h3>`;
  const table = (head, rows) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:13px"><tr>${head}</tr>${rows}</table>`;
  const none = t => `<p style="margin:0;color:#999;font-size:13px">${t}</p>`;

  const inner = `
    <p style="margin:0 0 2px;font-size:12px;color:#999">DAILY SUMMARY</p>
    <h2 style="margin:0 0 10px;font-size:20px">${fmtDate(day)}</h2>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      ${card('Money received', ghc(received), '#1a8a3a')}${card('Expenses', ghc(spent), '#c0392b')}${card('Cash in − out', ghc(received - spent), received - spent >= 0 ? '#1a8a3a' : '#c0392b')}</tr><tr>
      ${card('New rentals', `${made.rentals} · ${ghc(made.rental_value)}`)}${card('New bookings', `${made.bookings} · ${ghc(made.booking_value)}`)}${card('Out now / overdue', `${out.active} / <span style="color:${out.overdue ? '#c0392b' : 'inherit'}">${out.overdue}</span>`)}</tr></table>
    <p style="margin:6px 0 0;font-size:12px;color:#888">Went out today: ${wentOut.n} · Returned today: ${returned.n}${+made.discounts ? ` · Discounts given: ${ghc(made.discounts)}` : ''} · Money received includes deposits.</p>

    ${h3('Payments today')}
    ${pays.length ? table(`<th ${TH}>Method</th><th ${TH}>Count</th><th ${THR}>Amount</th>`,
        pays.map(p => `<tr><td ${TD}>${esc(p.method)}</td><td ${TD}>${p.n}</td><td ${TDR}>${ghc(p.total)}</td></tr>`).join('')) : none('No payments recorded today.')}

    ${h3('Expenses today')}
    ${exps.length ? table(`<th ${TH}>Category</th><th ${TH}>Count</th><th ${THR}>Amount</th>`,
        exps.map(e => `<tr><td ${TD}>${esc(e.category)}</td><td ${TD}>${e.n}</td><td ${TDR}>${ghc(e.total)}</td></tr>`).join('')) : none('No expenses recorded today.')}

    ${h3(`Overdue (${out.overdue})`)}
    ${overdue.length ? table(`<th ${TH}>Rental</th><th ${TH}>Client</th><th ${TH}>Was due</th><th ${THR}>Balance</th>`,
        overdue.map(o => `<tr><td ${TD}>${ref(o.id)}<div style="font-size:11px;color:#999">${esc(o.items || '')}</div></td><td ${TD}>${esc(o.name)}<div style="font-size:11px;color:#999">${esc(o.phone || '')}</div></td>
          <td ${TD}>${fmtDate(o.end_date)}, ${fmtTime(o.return_time || '19:00')}</td><td ${TDR}>${ghc(o.balance)}</td></tr>`).join('')) : none('Nothing overdue. 🎉')}

    ${h3('Tomorrow')}
    ${tomorrow.length ? table(`<th ${TH}></th><th ${TH}>Time</th><th ${TH}>Client</th><th ${TH}>Items</th>`,
        tomorrow.map(t => `<tr><td ${TD}><b style="color:${t.status === 'booked' ? '#7b4dd8' : '#E8520A'}">${t.status === 'booked' ? 'Pickup' : 'Return'}</b></td>
          <td ${TD}>${fmtTime(t.status === 'booked' ? (t.pickup_time || '08:00') : (t.return_time || '19:00'))}</td><td ${TD}>${esc(t.name)}<div style="font-size:11px;color:#999">${ref(t.id)}</div></td><td ${TD}>${esc(t.items || '')}</td></tr>`).join(''))
      : none('No pickups or returns booked for tomorrow.')}

    ${h3('This month so far')}
    ${table(`<th ${TH}>Rental revenue</th><th ${TH}>Expenses</th><th ${THR}>Net profit</th>`,
      `<tr><td ${TD}>${ghc(month.revenue)}</td><td ${TD}>${ghc(month.expenses)}</td><td ${TDR}><b style="color:${month.revenue - month.expenses >= 0 ? '#1a8a3a' : '#c0392b'}">${ghc(month.revenue - month.expenses)}</b></td></tr>`)}

    ${(failed.n || deletes.n) ? `${h3('Worth a look')}<p style="margin:0;font-size:13px">${failed.n ? `⚠ ${failed.n} failed sign-in${failed.n === 1 ? '' : 's'} today. ` : ''}${deletes.n ? `🗑 ${deletes.n} delete${deletes.n === 1 ? '' : 's'} today. ` : ''}See the Activity Log for details.</p>` : ''}
    ${email.baseUrl() ? `<p style="margin:22px 0 0">${`<a href="${esc(email.baseUrl())}" style="display:inline-block;background:#E8520A;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:700">Open Creative Rentals</a>`}</p>` : ''}`;
  return { subject: `Daily summary ${fmtDate(day)} — received ${ghc(received)}, ${out.overdue} overdue`,
           html: email.layout('Daily summary', inner, `Received ${ghc(received)} · Expenses ${ghc(spent)} · ${out.overdue} overdue`) };
}

async function dailySummary(today, hm, settings) {
  if (hm < (settings.summary_time || '19:30')) return;
  const key = `summary:${today}`;
  if (await alreadySent(key) || await gaveUp(key)) return;
  const to = await summaryRecipients(settings);
  if (!to.length) return;
  const s = await buildSummary(today);
  await email.send({ ...s, to, kind: 'summary', dedupe_key: key });
}

let running = false, timer = null;
async function tick() {
  if (running || !email.configured()) return;
  running = true;
  try {
    const settings = await email.getSettings();
    const { rows: [t] } = await db.query(`SELECT to_char(${NOW_GH}, 'YYYY-MM-DD') AS today, to_char(${NOW_GH}, 'HH24:MI') AS hm`);
    await db.query(OVERDUE_SQL);
    if (settings.reminders) await returnReminders();
    if (settings.overdue)   await overdueNotices(t.today, t.hm);
    if (settings.summary)   await dailySummary(t.today, t.hm, settings);
  } catch (err) { console.error('[email scheduler]', err.message); }
  finally { running = false; }
}

function start() {
  if (timer) return;
  console.log(email.configured() ? `Email: on (sending as ${email.from()})` : 'Email: off — add RESEND_API_KEY in Render → Environment to turn it on');
  setTimeout(tick, 15000).unref();
  timer = setInterval(tick, 60000); timer.unref();
}

module.exports = { start, tick, buildSummary, loadRental, summaryRecipients };
