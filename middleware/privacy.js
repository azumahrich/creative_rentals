/*
 * Staff don't see clients' full phone numbers or ID details.
 * They get a masked version (e.g. "••• ••• 567", "GHA-•••••••2-0") so they can still
 * confirm a client's identity ("is your number ending 567?").
 * Admins and the Super Admin see everything.
 */
const isAdminRole = role => role === 'admin' || role === 'superadmin';

function maskPhone(p) {
  if (!p) return p;
  const d = String(p).replace(/\D/g, '');
  return d.length >= 4 ? `••• ••• ${d.slice(-3)}` : '•••';
}

function maskId(s) {
  if (!s) return s;
  s = String(s);
  if (s.length <= 5) return '•'.repeat(s.length);
  return s.slice(0, 4) + '•'.repeat(Math.max(3, s.length - 7)) + s.slice(-3);
}

// Mask the sensitive fields on a client / rental row for non-admin users
function protectClient(row, user) {
  if (!row || (user && isAdminRole(user.role))) return row;
  const out = { ...row, contact_hidden: true };
  if ('phone' in out)        out.phone        = maskPhone(out.phone);
  if ('client_phone' in out) out.client_phone = maskPhone(out.client_phone);
  if ('ghana_card' in out)   out.ghana_card   = maskId(out.ghana_card);
  if ('id_number' in out)    out.id_number    = maskId(out.id_number);
  return out;
}

module.exports = { protectClient, maskPhone, maskId, isAdminRole };
