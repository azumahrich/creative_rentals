const router = require('express').Router();
const db     = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const activity = require('../middleware/activity');

/*
 * Business expenses (fuel, repairs, shop rent, electricity, wages…).
 * Recorded by admins; deducted from rental revenue in Reports to show net profit.
 */
router.use(requireAuth, requireAdmin);

const CATEGORIES = ['Transport & fuel', 'Equipment repair & maintenance', 'Equipment purchase', 'Batteries, cables & accessories',
  'Shop rent', 'Electricity & water', 'Internet, phone & airtime', 'Staff wages & allowances', 'Marketing & advertising',
  'Cleaning & supplies', 'Taxes, levies & fees', 'Other'];
const METHODS = { cash: 'Cash', momo: 'Mobile Money', bank_transfer: 'Bank transfer', cheque: 'Cheque', other: 'Other' };
const isDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '');

function clean(b, partial) {
  const out = {};
  if (!partial || b.spent_on !== undefined) {
    if (!isDate(b.spent_on)) return { error: 'Choose the date the money was spent' };
    out.spent_on = b.spent_on;
  }
  if (!partial || b.category !== undefined) {
    if (!b.category || !String(b.category).trim()) return { error: 'Choose a category' };
    out.category = String(b.category).trim().slice(0, 60);
  }
  if (!partial || b.description !== undefined) {
    if (!b.description || !String(b.description).trim()) return { error: 'Say what the money was spent on' };
    out.description = String(b.description).trim().slice(0, 300);
  }
  if (!partial || b.amount !== undefined) {
    if (!(+b.amount > 0)) return { error: 'Amount must be more than 0' };
    out.amount = Math.round(+b.amount * 100) / 100;
  }
  if (b.method !== undefined)       out.method = METHODS[b.method] ? b.method : 'other';
  if (b.paid_to !== undefined)      out.paid_to = b.paid_to ? String(b.paid_to).trim().slice(0, 120) : null;
  if (b.reference !== undefined)    out.reference = b.reference ? String(b.reference).trim().slice(0, 120) : null;
  if (b.equipment_id !== undefined) out.equipment_id = parseInt(b.equipment_id) || null;
  return { data: out };
}

const SELECT = `SELECT x.*, e.name AS equipment_name FROM expenses x LEFT JOIN equipment e ON e.id = x.equipment_id`;
const line = x => `${activity.money(x.amount)} — ${x.category}: ${x.description}${x.paid_to ? ' (paid to ' + x.paid_to + ')' : ''} on ${x.spent_on}`;

// GET /api/expenses?from=&to=&category=&q=
router.get('/', async (req, res) => {
  const { from, to, category, q } = req.query;
  const w = [], p = [];
  if (isDate(from)) w.push(`x.spent_on >= $${p.push(from)}`);
  if (isDate(to))   w.push(`x.spent_on <= $${p.push(to)}`);
  if (category)     w.push(`x.category = $${p.push(category)}`);
  if (q)            w.push(`(x.description ILIKE $${p.push('%' + q + '%')} OR x.paid_to ILIKE $${p.length} OR x.reference ILIKE $${p.length} OR e.name ILIKE $${p.length})`);
  try {
    const { rows } = await db.query(`${SELECT} ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY x.spent_on DESC, x.id DESC LIMIT 2000`, p);
    res.json({ items: rows, categories: CATEGORIES });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/expenses
router.post('/', async (req, res) => {
  const { error, data } = clean(req.body || {}, false);
  if (error) return res.status(400).json({ error });
  try {
    const { rows: [x] } = await db.query(
      `INSERT INTO expenses (spent_on, category, description, amount, method, paid_to, reference, equipment_id, created_by, created_by_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [data.spent_on, data.category, data.description, data.amount, data.method || 'cash', data.paid_to || null,
       data.reference || null, data.equipment_id || null, req.user.id, req.user.name]);
    const { rows: [full] } = await db.query(`${SELECT} WHERE x.id=$1`, [x.id]);
    activity.note(res, { action: 'expense_create', entity: 'expense', entity_id: x.id,
      summary: `Recorded expense ${line(full)}${full.equipment_name ? ' for ' + full.equipment_name : ''}` });
    res.status(201).json(full);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/expenses/:id
router.patch('/:id', async (req, res) => {
  const { error, data } = clean(req.body || {}, true);
  if (error) return res.status(400).json({ error });
  const keys = Object.keys(data);
  if (!keys.length) return res.status(400).json({ error: 'Nothing to change' });
  try {
    const { rows: [before] } = await db.query(`${SELECT} WHERE x.id=$1`, [req.params.id]);
    if (!before) return res.status(404).json({ error: 'Expense not found' });
    await db.query(`UPDATE expenses SET ${keys.map((k, i) => `${k}=$${i + 1}`).join(', ')} WHERE id=$${keys.length + 1}`,
      [...keys.map(k => data[k]), req.params.id]);
    const { rows: [after] } = await db.query(`${SELECT} WHERE x.id=$1`, [req.params.id]);
    const changes = activity.diff(
      { ...before, equipment_id: before.equipment_name || '' },
      { ...after, equipment_id: after.equipment_name || '' },
      ['spent_on', 'category', 'description', 'amount', 'method', 'paid_to', 'reference', 'equipment_id'])
      .map(c => ({ ...c, field: { spent_on: 'Date', description: 'Description', amount: 'Amount', method: 'Method',
                                  paid_to: 'Paid to', reference: 'Reference', equipment_id: 'Equipment' }[c.field] || c.field }));
    activity.note(res, { action: 'expense_update', entity: 'expense', entity_id: after.id, changes,
      summary: `Edited expense ${line(after)}${changes.length ? ': ' + changes.map(c => `${c.field} ${c.from} → ${c.to}`).join('; ') : ''}` });
    res.json(after);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/expenses/:id
router.delete('/:id', async (req, res) => {
  try {
    const { rows: [x] } = await db.query(`${SELECT} WHERE x.id=$1`, [req.params.id]);
    if (!x) return res.status(404).json({ error: 'Expense not found' });
    await db.query('DELETE FROM expenses WHERE id=$1', [x.id]);
    activity.note(res, { action: 'expense_delete', entity: 'expense', entity_id: x.id,
      changes: [{ field: 'Expense', from: line(x), to: '(deleted)' }], summary: `Deleted expense ${line(x)}` });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.CATEGORIES = CATEGORIES;
module.exports = router;
