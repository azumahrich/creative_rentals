/*
 * Loyalty discount — applied automatically to every new rental.
 * Rule (editable by the Super Admin in Settings):
 *   rental charge below min_amount → no discount
 *   from min_amount up to the threshold → low_pct off; above the threshold → high_pct off.
 * The discount is on the rental charge only. The refundable deposit is never discounted.
 */
const DEFAULT = { enabled: true, min_amount: 1000, threshold: 1500, low_pct: 5, high_pct: 8 };

async function getRules(q) {
  try {
    const { rows: [r] } = await q.query("SELECT value FROM app_meta WHERE key='discount_rules'");
    return r ? { ...DEFAULT, ...JSON.parse(r.value) } : { ...DEFAULT };
  } catch { return { ...DEFAULT }; }
}

const round2 = n => Math.round((+n + Number.EPSILON) * 100) / 100;

function discountFor(gross, rules) {
  gross = round2(gross);
  if (!rules.enabled || gross <= 0 || gross < +rules.min_amount) return { gross, pct: 0, amount: 0, net: gross };
  const pct = gross <= +rules.threshold ? +rules.low_pct : +rules.high_pct;
  const amount = round2(gross * pct / 100);
  return { gross, pct, amount, net: round2(gross - amount) };
}

module.exports = { getRules, discountFor, DEFAULT, round2 };
