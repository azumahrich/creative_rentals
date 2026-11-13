// Email settings & log — Super Admin only
const router = require('express').Router();
const db = require('../db');
const { requireAuth, requireSuperAdmin } = require('../middleware/auth');
const { note } = require('../middleware/activity');
const email = require('../lib/email');
const scheduler = require('../lib/scheduler');

router.use(requireAuth, requireSuperAdmin);

// GET /api/email — set-up status, settings and the latest emails
router.get('/', async (req, res) => {
  try {
    const settings = await email.getSettings();
    const { rows: log } = await db.query(
      `SELECT l.id, l.at, l.kind, l.to_addr, l.subject, l.rental_id, l.status, l.error, c.name AS client_name
       FROM email_log l LEFT JOIN clients c ON c.id = l.client_id
       ORDER BY l.id DESC LIMIT 100`);
    const { rows: [counts] } = await db.query(
      `SELECT COUNT(*) FILTER (WHERE status='sent' AND at > NOW() - INTERVAL '1 day')::int AS sent_24h,
              COUNT(*) FILTER (WHERE status='sent' AND at > date_trunc('month', NOW()))::int AS sent_month,
              COUNT(*) FILTER (WHERE status='failed' AND at > NOW() - INTERVAL '7 days')::int AS failed_7d
       FROM email_log`);
    const summaryTo = await scheduler.summaryRecipients(settings);
    const { rows: [cl] } = await db.query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE COALESCE(email,'') <> '')::int AS with_email FROM clients`);
    res.json({ configured: email.configured(), from: email.from(), app_url: email.baseUrl(),
      using_test_sender: /@resend\.dev>?$/i.test(email.from()),
      settings, summary_recipients: summaryTo, clients: cl, counts, log });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/email/settings
router.put('/settings', async (req, res) => {
  const b = req.body || {};
  const s = { reminders: !!b.reminders, overdue: !!b.overdue, summary: !!b.summary,
              summary_to: email.splitEmails(b.summary_to).join(', '),
              reply_to: String(b.reply_to || '').trim(),
              summary_time: String(b.summary_time || '19:30') };
  const bad = email.splitEmails(s.summary_to).filter(e => !email.isEmail(e));
  if (bad.length) return res.status(400).json({ error: `Not a valid email address: ${bad.join(', ')}` });
  if (s.reply_to && !email.isEmail(s.reply_to)) return res.status(400).json({ error: 'The reply-to address is not a valid email' });
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s.summary_time)) return res.status(400).json({ error: 'Choose a time for the daily summary' });
  try {
    const before = await email.getSettings();
    await email.saveSettings(s);
    const onOff = x => ['reminders', 'overdue', 'summary'].map(k => `${k}: ${x[k] ? 'on' : 'off'}`).join(', ');
    note(res, { action: 'settings_update', entity: 'settings', summary: `Changed email settings (${onOff(s)}; summary at ${s.summary_time}${s.summary_to ? ' to ' + s.summary_to : ''})`,
      changes: Object.keys(s).filter(k => String(before[k]) !== String(s[k])).map(k => ({ field: k, from: String(before[k]), to: String(s[k]) })) });
    res.json(s);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/email/test { to }
router.post('/test', async (req, res) => {
  const to = String((req.body || {}).to || '').trim();
  if (!email.isEmail(to)) return res.status(400).json({ error: 'Enter a valid email address' });
  const inner = `<h2 style="margin:0 0 10px;font-size:20px">It works! ✅</h2>
    <p style="margin:0">This test email was sent from the Creative Rentals app by ${email.esc(req.user.name)}.
    Invoices, reminders and the daily summary will look like this.</p>`;
  const r = await email.send({ to, subject: 'Test email from Creative Rentals', html: email.layout('Test email', inner), kind: 'test', user_id: req.user.id });
  if (!r.ok) return res.status(400).json({ error: r.error });
  note(res, { action: 'email_test', entity: 'email', summary: `Sent a test email to ${to}` });
  res.json({ ok: true });
});

// POST /api/email/summary-now — send today's summary right away (doesn't stop the evening one)
router.post('/summary-now', async (req, res) => {
  try {
    const settings = await email.getSettings();
    const to = await scheduler.summaryRecipients(settings);
    if (!to.length) return res.status(400).json({ error: 'No one to send it to. Add your email on the Users page, or fill in "Send the summary to".' });
    const { rows: [t] } = await db.query(`SELECT to_char(NOW() AT TIME ZONE 'Africa/Accra','YYYY-MM-DD') AS today`);
    const s = await scheduler.buildSummary(t.today);
    const r = await email.send({ ...s, to, kind: 'summary', user_id: req.user.id });
    if (!r.ok) return res.status(400).json({ error: r.error });
    note(res, { action: 'email_summary', entity: 'email', summary: `Sent today's summary now to ${to.join(', ')}` });
    res.json({ ok: true, to });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
