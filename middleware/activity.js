/*
 * Activity log — records who did what, when, and from which device.
 *
 * Route handlers describe what happened by calling note(res, {...}) before replying.
 * The entry is written once the reply has gone out successfully, so failed or refused
 * actions aren't logged as if they happened (except failed sign-ins, which are logged on purpose).
 */
const db = require('../db');

function deviceFrom(ua = '') {
  const os = /Android/i.test(ua) ? 'Android' : /iPhone|iPad|iPod/i.test(ua) ? (/iPad/i.test(ua) ? 'iPad' : 'iPhone')
    : /Windows/i.test(ua) ? 'Windows' : /Mac OS X|Macintosh/i.test(ua) ? 'Mac' : /Linux/i.test(ua) ? 'Linux' : '';
  const br = /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /SamsungBrowser/.test(ua) ? 'Samsung Internet'
    : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '';
  return [br, os].filter(Boolean).join(' on ') || (ua ? ua.slice(0, 60) : 'Unknown device');
}

async function write(entry) {
  try {
    await db.query(
      `INSERT INTO activity_log (user_id, username, user_name, role, action, entity, entity_id, client_id, summary, changes, ip, device)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [entry.user_id || null, entry.username || null, entry.user_name || null, entry.role || null,
       entry.action, entry.entity || null, entry.entity_id || null, entry.client_id || null,
       String(entry.summary).slice(0, 1000), entry.changes ? JSON.stringify(entry.changes) : null,
       entry.ip || null, entry.device || null]);
  } catch (err) { console.error('[activity] could not record:', err.message); }   // never break the app over logging
}

// Attach to every /api request: writes the noted entry after a successful reply
function activityRecorder(req, res, next) {
  res.on('finish', () => {
    const a = res.locals.activity;
    if (!a || (res.statusCode >= 400 && !a.force)) return;
    const u = a.user || req.user || {};
    write({ ...a, user_id: u.id, username: u.username, user_name: u.name, role: u.role,
            ip: req.ip, device: deviceFrom(req.get('user-agent')) });
  });
  next();
}

// Describe what happened. Several notes in one request are merged.
function note(res, a) { res.locals.activity = { ...(res.locals.activity || {}), ...a }; }

// "field: old → new" for every field that actually changed
const LABELS = { name:'Name', phone:'Phone', email:'Email', company:'Company', id_number:'ID number', ghana_card:'Ghana Card',
  notes:'Notes', joined:'Joined', serial:'Serial', category:'Category', price:'Rate/day', deposit:'Deposit',
  total:'Quantity owned', available:'Available', role:'Role', active:'Status', username:'Username' };
function diff(before, after, fields) {
  const out = [];
  for (const f of fields) {
    if (!(f in after)) continue;
    const norm = v => v === null || v === undefined || v === '' ? '' : (typeof v === 'number' || /^-?\d+(\.\d+)?$/.test(String(v)) ? String(+v) : String(v));
    const show = v => f === 'active' ? (v === true || v === 'true' ? 'Active' : 'Disabled') : (v === null || v === undefined || v === '' ? '(blank)' : String(v));
    if (norm(before[f]) !== norm(after[f])) out.push({ field: LABELS[f] || f, from: show(before[f]), to: show(after[f]) });
  }
  return out;
}

const ref = id => '#R-' + String(id).padStart(4, '0');
const money = n => 'GH₵ ' + (+n || 0).toLocaleString('en-GH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

module.exports = { activityRecorder, note, write, diff, deviceFrom, ref, money };
