/*
 * Email through Resend (https://resend.com)
 *
 * Render → web service → Environment:
 *   RESEND_API_KEY = re_xxxxxxxx          (required — from resend.com → API Keys)
 *   EMAIL_FROM     = Creative Rentals <bookings@yourdomain.com>
 *                    (a sender on a domain you verified in Resend → Domains.
 *                     Until then, "onboarding@resend.dev" only delivers to your own Resend sign-up email.)
 *   APP_URL        = (optional) the app's web address, used in "Forgot password" links.
 *                    Render sets RENDER_EXTERNAL_URL automatically, so this is usually not needed.
 *
 * Every email is written to email_log. Automatic emails carry a dedupe_key, so a reminder or
 * summary can never go out twice — even if the app restarts.
 */
const db = require('../db');

const API = (process.env.RESEND_API_URL || 'https://api.resend.com').replace(/\/+$/, '');
const key = () => (process.env.RESEND_API_KEY || '').trim();
const from = () => (process.env.EMAIL_FROM || '').trim() || 'Creative Rentals <onboarding@resend.dev>';
const configured = () => !!key();
const baseUrl = () => (process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || '').trim().replace(/\/+$/, '');

const BUSINESS = {
  name: 'Creative Rentals',
  address: 'Adum-Kumasi, Opposite Oyerepa FM & Bosheba Building',
  phones: '0241 334 486 | 024 816 4307',
  email: 'creativerentals25@gmail.com',
};

const DEFAULT_SETTINGS = { reminders: true, overdue: true, summary: true, summary_to: '',
                           reply_to: BUSINESS.email, summary_time: '19:30' };
async function getSettings() {
  const { rows } = await db.query("SELECT value FROM app_meta WHERE key='email_settings'");
  let s = {}; try { s = rows.length ? JSON.parse(rows[0].value) : {}; } catch { s = {}; }
  return { ...DEFAULT_SETTINGS, ...s };
}
async function saveSettings(s) {
  await db.query(`INSERT INTO app_meta (key, value) VALUES ('email_settings', $1)
                  ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [JSON.stringify(s)]);
}

const EMAIL_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]{2,}$/;
const isEmail = e => EMAIL_RE.test(String(e || '').trim());
const splitEmails = s => String(s || '').split(/[,;\s]+/).map(x => x.trim()).filter(Boolean);

/*
 * Send one email.
 *   opts: { to, subject, html, text?, kind, dedupe_key?, rental_id?, client_id?, user_id?, attachments? }
 * Returns { ok, id?, skipped?, error? }. Never throws.
 */
async function send(opts) {
  const to = [].concat(opts.to).map(x => String(x || '').trim()).filter(Boolean);
  if (!to.length || !to.every(isEmail)) return { ok: false, error: 'No valid email address' };
  if (!configured()) return { ok: false, error: 'Email is not set up yet (RESEND_API_KEY is missing in Render → Environment)' };

  // Reserve the log row first — the unique dedupe_key is what stops duplicates
  let logId;
  try {
    const { rows } = await db.query(
      `INSERT INTO email_log (kind, dedupe_key, to_addr, subject, rental_id, client_id, user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
      [opts.kind, opts.dedupe_key || null, to.join(', '), String(opts.subject).slice(0, 300),
       opts.rental_id || null, opts.client_id || null, opts.user_id || null]);
    if (!rows.length) return { ok: true, skipped: true };
    logId = rows[0].id;
  } catch (err) { return { ok: false, error: 'Could not write email log: ' + err.message }; }

  const settings = await getSettings().catch(() => DEFAULT_SETTINGS);
  const body = { from: from(), to, subject: opts.subject, html: opts.html };
  if (opts.text) body.text = opts.text;
  if (isEmail(settings.reply_to)) body.reply_to = settings.reply_to.trim();
  if (opts.attachments) body.attachments = opts.attachments;
  body.tags = [{ name: 'kind', value: String(opts.kind).replace(/[^A-Za-z0-9_-]/g, '_') }];

  let result;
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20000);
    const r = await fetch(API + '/emails', {
      method: 'POST', signal: ctl.signal,
      headers: { Authorization: 'Bearer ' + key(), 'Content-Type': 'application/json',
                 'Idempotency-Key': 'cr-' + (opts.dedupe_key || 'log-' + logId) },
      body: JSON.stringify(body) });
    clearTimeout(t);
    const j = await r.json().catch(() => ({}));
    result = r.ok ? { ok: true, id: j.id } : { ok: false, error: explain(r.status, j) };
  } catch (err) {
    result = { ok: false, error: err.name === 'AbortError' ? 'Resend did not answer in time' : 'Could not reach Resend: ' + err.message };
  }
  await db.query('UPDATE email_log SET status=$1, provider_id=$2, error=$3 WHERE id=$4',
    [result.ok ? 'sent' : 'failed', result.id || null, result.error || null, logId]).catch(() => {});
  // A failed automatic email gives its key back (renamed key:fail:N) so it can be tried again later.
  // The scheduler stops retrying after 3 failures.
  if (!result.ok && opts.dedupe_key)
    await db.query("UPDATE email_log SET dedupe_key = dedupe_key || ':fail:' || id WHERE id=$1", [logId]).catch(() => {});
  if (!result.ok) console.error(`[email] ${opts.kind} to ${to.join(', ')} failed: ${result.error}`);
  return result;
}

// Turn Resend errors into plain words
function explain(status, j) {
  const msg = (j && (j.message || j.error)) || '';
  if (status === 401 || (status === 403 && /api key/i.test(msg))) return 'The Resend API key is wrong or was deleted. Create a new one and update RESEND_API_KEY.';
  if (status === 403 && /testing emails|own email|verify a domain/i.test(msg))
    return 'Resend will only deliver to your own sign-up email until you verify a domain (Resend → Domains) and set EMAIL_FROM to an address on it.';
  if (/domain is not verified|not verified/i.test(msg)) return 'The sender domain in EMAIL_FROM is not verified yet in Resend → Domains.';
  if (status === 422) return 'Resend refused the email: ' + msg;
  if (status === 429) return 'Daily/monthly email limit reached on your Resend plan (free plan: 100 a day).';
  return `Resend error ${status}${msg ? ': ' + msg : ''}`;
}

// ─── Templates ───────────────────────────────────────────────────────────────
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const ghc = n => 'GH₵ ' + (+n || 0).toLocaleString('en-GH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const ref = id => '#R-' + String(id).padStart(4, '0');
const fmtDate = d => d ? new Date(String(d).length === 10 ? d + 'T12:00:00Z' : d)
  .toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Africa/Accra' }) : '—';
const fmtTime = t => { const m = /^\s*(\d{1,2}):(\d{2})/.exec(t || ''); if (!m) return t || ''; const h = +m[1]; return `${h % 12 || 12}:${m[2]} ${h < 12 ? 'AM' : 'PM'}`; };
const pickupOf = r => r.pickup_time || '08:00', returnOf = r => r.return_time || '19:00';

function layout(title, inner, preheader = '') {
  const logo = baseUrl() ? `<img src="${baseUrl()}/icon-192.png" width="44" height="44" alt="" style="vertical-align:middle;border-radius:50%;margin-right:10px">` : '';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(title)}</title></head>
<body style="margin:0;background:#f3f1ee;font-family:Segoe UI,Helvetica,Arial,sans-serif;color:#1d1d1f">
<span style="display:none;max-height:0;overflow:hidden">${esc(preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f1ee;padding:20px 10px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:#fff;border-radius:12px;overflow:hidden">
<tr><td style="background:#111;padding:16px 22px;color:#fff;font-size:18px;font-weight:700">${logo}<span style="vertical-align:middle">CREATIVE <span style="color:#E8520A">RENTALS</span></span></td></tr>
<tr><td style="padding:22px;font-size:14px;line-height:1.55">${inner}</td></tr>
<tr><td style="background:#faf8f6;padding:14px 22px;font-size:12px;color:#777;border-top:1px solid #eee">
${esc(BUSINESS.address)}<br>Tel: ${esc(BUSINESS.phones)} · ${esc(BUSINESS.email)}<br><span style="color:#E8520A">RENT · CREATE · RETURN</span></td></tr>
</table></td></tr></table></body></html>`;
}
const btn = (href, label) => `<a href="${esc(href)}" style="display:inline-block;background:#E8520A;color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;font-weight:700">${esc(label)}</a>`;
const TH = 'style="text-align:left;padding:7px 6px;border-bottom:2px solid #eee;font-size:12px;color:#777"';
const THR = 'style="text-align:right;padding:7px 6px;border-bottom:2px solid #eee;font-size:12px;color:#777"';
const TD = 'style="padding:7px 6px;border-bottom:1px solid #f0f0f0;vertical-align:top"';
const TDR = 'style="padding:7px 6px;border-bottom:1px solid #f0f0f0;text-align:right;white-space:nowrap"';

function periodHtml(r) {
  return (!r.end_date || r.start_date === r.end_date)
    ? `${fmtDate(r.start_date)}<br>Pickup ${fmtTime(pickupOf(r))} · Return by <b>${fmtTime(returnOf(r))}</b> (same day)`
    : `Pickup ${fmtDate(r.start_date)}, ${fmtTime(pickupOf(r))}<br>Return by <b>${fmtDate(r.end_date)}, ${fmtTime(returnOf(r))}</b> · ${r.days} days`;
}
function itemsTable(r, withMoney = true) {
  const days = r.days || 1;
  const rows = (r.equipment || []).map(e => `<tr><td ${TD}>${esc(e.name)}${e.serial ? `<div style="font-size:11px;color:#999">S/N ${esc(e.serial)}</div>` : ''}</td>
    <td ${TD}>${e.qty}</td>${withMoney ? `<td ${TDR}>${ghc(e.unit_price)}${days > 1 ? ' × ' + days + ' days' : ''}</td><td ${TDR}>${ghc(e.unit_price * e.qty * days)}</td>` : ''}</tr>`).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:12px 0;font-size:13px">
    <tr><th ${TH}>Item</th><th ${TH}>Qty</th>${withMoney ? `<th ${THR}>Rate</th><th ${THR}>Amount</th>` : ''}</tr>${rows}</table>`;
}

function invoiceEmail(r) {
  const paid = +r.total_paid || 0, subtotal = +r.subtotal || 0, deposit = +r.deposit_amt || 0;
  const balance = subtotal + deposit - paid, disc = +r.discount_amt || 0, gross = +(r.gross_amount || subtotal);
  const booking = r.status === 'booked';
  const title = `${booking ? 'Booking confirmation' : 'Rental invoice'} ${ref(r.id)}`;
  const line = (label, val, style = '') => `<tr><td style="padding:4px 6px;text-align:right;${style}">${label}</td><td style="padding:4px 6px;text-align:right;white-space:nowrap;${style}">${val}</td></tr>`;
  const inner = `
    <p style="margin:0 0 4px;font-size:12px;color:#999">${booking ? 'BOOKING CONFIRMATION' : 'RENTAL INVOICE'} · ${ref(r.id)}</p>
    <h2 style="margin:0 0 14px;font-size:20px">Hello ${esc((r.client_name || '').split(' ')[0] || 'there')},</h2>
    <p style="margin:0 0 14px">${booking
      ? 'Thank you for booking with Creative Rentals. Your equipment is reserved for the dates below.'
      : 'Thank you for renting with Creative Rentals. Here are the details of your rental.'}</p>
    <table role="presentation" width="100%" style="background:#faf8f6;border-radius:8px;font-size:13px" cellpadding="10"><tr>
      <td valign="top"><b style="color:#E8520A;font-size:11px">BILLED TO</b><br>${esc(r.client_name)}${r.client_phone ? '<br>' + esc(r.client_phone) : ''}</td>
      <td valign="top"><b style="color:#E8520A;font-size:11px">RENTAL PERIOD</b><br>${periodHtml(r)}</td></tr></table>
    ${itemsTable(r)}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:13px">
      ${disc > 0 ? line('Equipment subtotal', ghc(gross)) + line(`Loyalty discount (${+r.discount_pct}%)`, '− ' + ghc(disc), 'color:#1a8a3a') + line('Rental after discount', ghc(subtotal))
                 : line('Equipment subtotal', ghc(subtotal))}
      ${line('Refundable deposit', ghc(deposit))}
      ${line('Amount paid', '(' + ghc(paid) + ')', 'color:#1a8a3a')}
      ${line('<b>BALANCE DUE</b>', '<b>' + ghc(balance) + '</b>', 'color:#E8520A;font-size:15px;border-top:2px solid #eee')}
    </table>
    ${(r.payments || []).length ? `<p style="margin:16px 0 4px;font-weight:700;font-size:13px">Payments received</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:12px;border-collapse:collapse">
      ${(r.payments || []).map(p => `<tr><td ${TD}>${fmtDate(p.paid_at)}</td><td ${TD}>${esc(p.method)}</td><td ${TD}>${esc(p.reference || '—')}</td><td ${TDR}>${ghc(p.amount)}</td></tr>`).join('')}</table>` : ''}
    <p style="margin:18px 0 0;font-size:12px;color:#666;border-top:1px solid #eee;padding-top:12px">
      Please bring a valid ID at pickup. The deposit is refunded after the equipment is returned and checked.
      Late returns incur extra fees — if you need more time, call us before your return time.
      Reply to this email or call ${esc(BUSINESS.phones)} with any questions.</p>`;
  return { subject: `${title} — Creative Rentals`, html: layout(title, inner, `${booking ? 'Booking' : 'Rental'} ${ref(r.id)} · ${fmtDate(r.start_date)}`) };
}

function returnReminderEmail(r) {
  const title = `Reminder: please return your equipment by ${fmtTime(returnOf(r))} today`;
  const inner = `
    <h2 style="margin:0 0 12px;font-size:20px">Hello ${esc((r.client_name || '').split(' ')[0] || 'there')},</h2>
    <p style="margin:0 0 12px">This is a friendly reminder that your rental <b>${ref(r.id)}</b> is due back
      <b>today, ${fmtDate(r.end_date)}, by ${fmtTime(returnOf(r))}</b> at our shop in Adum-Kumasi (opposite Oyerepa FM).</p>
    ${itemsTable(r, false)}
    <p style="margin:0 0 12px">Please return everything clean and complete, with memory cards empty.
      If you need more time, call us <b>before ${fmtTime(returnOf(r))}</b> on ${esc(BUSINESS.phones)} — extensions depend on availability.</p>
    <p style="margin:0;color:#666">Thank you for creating with us!</p>`;
  return { subject: `Return today by ${fmtTime(returnOf(r))} — ${ref(r.id)} · Creative Rentals`, html: layout(title, inner, `Due back today by ${fmtTime(returnOf(r))}`) };
}

function overdueEmail(r, lateDays) {
  const title = `Your rental ${ref(r.id)} is overdue`;
  const inner = `
    <h2 style="margin:0 0 12px;font-size:20px;color:#c0392b">Your rental is overdue</h2>
    <p style="margin:0 0 12px">Hello ${esc((r.client_name || '').split(' ')[0] || 'there')}, the equipment on rental <b>${ref(r.id)}</b> was due back on
      <b>${fmtDate(r.end_date)} by ${fmtTime(returnOf(r))}</b>${lateDays > 0 ? ` — that is ${lateDays} day${lateDays === 1 ? '' : 's'} ago` : ''}, and we have not received it yet.</p>
    ${itemsTable(r, false)}
    <p style="margin:0 0 12px">Please return it as soon as possible, or call us on <b>${esc(BUSINESS.phones)}</b> to arrange an extension.
      Late returns incur additional fees under our rental agreement.</p>
    <p style="margin:0;color:#666">If you have already returned it, thank you — please ignore this email.</p>`;
  return { subject: `Overdue: please return rental ${ref(r.id)} — Creative Rentals`, html: layout(title, inner, `Rental ${ref(r.id)} was due ${fmtDate(r.end_date)}`) };
}

function passwordResetEmail(user, link) {
  const inner = `
    <h2 style="margin:0 0 12px;font-size:20px">Reset your password</h2>
    <p style="margin:0 0 14px">Hello ${esc(user.name)}, someone (hopefully you) asked to reset the password for your
      Creative Rentals account <b>${esc(user.username)}</b>.</p>
    <p style="margin:0 0 18px">${btn(link, 'Choose a new password')}</p>
    <p style="margin:0 0 8px;font-size:12px;color:#666">This link works once and expires in 30 minutes.
      If the button doesn't work, copy this address into your browser:<br><span style="word-break:break-all">${esc(link)}</span></p>
    <p style="margin:0;font-size:12px;color:#666">If you didn't ask for this, ignore this email — your password stays the same.</p>`;
  return { subject: 'Reset your Creative Rentals password', html: layout('Reset your password', inner, 'Your password reset link (expires in 30 minutes)') };
}

module.exports = { send, configured, from, baseUrl, getSettings, saveSettings, isEmail, splitEmails, DEFAULT_SETTINGS,
  invoiceEmail, returnReminderEmail, overdueEmail, passwordResetEmail, layout, esc, ghc, ref, fmtDate, fmtTime, TH, THR, TD, TDR, BUSINESS };
