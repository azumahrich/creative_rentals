/*
 * Every client must have a valid Ghana Card number and phone number.
 *   Ghana Card: GHA-123456789-0   (GHA, 9 digits, check digit) — spaces/dashes/lower case are fixed up
 *   Phone:      024 123 4567, 0241234567, +233 24 123 4567 or 233241234567 — saved as "024 123 4567"
 */
function normalizeGhanaCard(v) {
  const s = String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const m = /^GHA(\d{9})(\d)$/.exec(s);
  return m ? `GHA-${m[1]}-${m[2]}` : null;
}

function normalizePhone(v) {
  let d = String(v || '').replace(/\D/g, '');
  if (d.startsWith('233') && d.length === 12) d = '0' + d.slice(3);
  if (!/^0[235]\d{8}$/.test(d)) return null;
  return `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}`;
}

/**
 * Checks and tidies the Ghana Card and phone in a client body.
 * partial=true (editing): only fields that were sent are checked, but they can't be emptied.
 * Returns an error message, or null if OK (body is updated in place).
 */
function checkClientIds(body, partial = false) {
  if (!partial || body.ghana_card !== undefined) {
    if (!String(body.ghana_card || '').trim()) return 'Ghana Card number is required';
    const g = normalizeGhanaCard(body.ghana_card);
    if (!g) return 'Ghana Card number must look like GHA-123456789-0';
    body.ghana_card = g;
  }
  if (!partial || body.phone !== undefined) {
    if (!String(body.phone || '').trim()) return 'Phone number is required';
    const p = normalizePhone(body.phone);
    if (!p) return 'Phone number must be a 10-digit Ghana number, e.g. 024 123 4567';
    body.phone = p;
  }
  return null;
}

module.exports = { normalizeGhanaCard, normalizePhone, checkClientIds };
