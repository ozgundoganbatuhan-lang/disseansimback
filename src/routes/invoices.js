// src/routes/invoices.js
// Frontend gönderir: {patient_id, amount, tax_rate, description, status}
// Frontend okur: inv.patient_id, stats.monthRevenue, stats.monthCount, stats.unpaidCount
// Frontend çağırır: PUT /invoices/:id {status:'paid'}
const router = require('express').Router();
const { v4: uuid } = require('uuid');
const db   = require('../db/database');
const auth = require('../middleware/auth');
const { _audit } = require('./auth');

router.use(auth);

function fmt(inv) {
  return {
    id:           inv.id,
    patient_id:   inv.patient_id,
    number:       inv.number,
    description:  inv.service,   // frontend description okur
    amount:       inv.amount,
    tax_rate:     inv.tax_rate || 0,
    status:       (inv.status||'paid').toLowerCase(),
    date:         inv.date,
    note:         inv.note,
    fn:           inv.first_name,
    ln:           inv.last_name,
    created_at:   inv.created_at,
  };
}

// GET /api/invoices
router.get('/', (req, res) => {
  const { from, to, status } = req.query;
  let sql = `SELECT i.*, p.first_name, p.last_name FROM invoices i
    JOIN patients p ON p.id=i.patient_id WHERE i.user_id=?`;
  const p = [req.user.id];
  if (from)   { sql += ' AND i.date>=?'; p.push(from); }
  if (to)     { sql += ' AND i.date<=?'; p.push(to); }
  if (status) { sql += ' AND lower(i.status)=?'; p.push(status.toLowerCase()); }
  sql += ' ORDER BY i.created_at DESC';
  res.json(db.prepare(sql).all(...p).map(fmt));
});

// GET /api/invoices/stats  — frontend: stats.monthRevenue / stats.monthCount / stats.unpaidCount
router.get('/stats', (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0,7);
  const monthRevenue = db.prepare(
    "SELECT COALESCE(SUM(amount),0) v FROM invoices WHERE user_id=? AND lower(status)='paid' AND date LIKE ?"
  ).get(req.user.id, month+'%').v;
  const monthCount = db.prepare(
    "SELECT COUNT(*) v FROM invoices WHERE user_id=? AND date LIKE ?"
  ).get(req.user.id, month+'%').v;
  const unpaidCount = db.prepare(
    "SELECT COUNT(*) v FROM invoices WHERE user_id=? AND lower(status)='pending'"
  ).get(req.user.id).v;
  res.json({ monthRevenue, monthCount, unpaidCount, month });
});

// POST /api/invoices
// frontend: {patient_id, amount, tax_rate, description, status}
router.post('/', (req, res) => {
  const { patient_id, amount, tax_rate, description, status } = req.body;
  if (!patient_id || amount == null)
    return res.status(400).json({ error: 'Hasta ve tutar zorunludur.' });

  const p = db.prepare('SELECT first_name,last_name FROM patients WHERE id=? AND user_id=?').get(patient_id, req.user.id);
  if (!p) return res.status(403).json({ error: 'Hasta bulunamadı.' });

  const u   = db.prepare('SELECT inv_counter FROM users WHERE id=?').get(req.user.id);
  const num = 'INV-' + String(u.inv_counter || 1).padStart(4, '0');
  db.prepare("UPDATE users SET inv_counter=inv_counter+1 WHERE id=?").run(req.user.id);

  const id = uuid();
  const dbStatus = status ? status.toUpperCase() : 'PAID';
  db.prepare(`INSERT INTO invoices (id,user_id,patient_id,number,service,amount,tax_rate,method,status,date,note)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, req.user.id, patient_id, num,
         description || 'Terapi Seansı',
         parseFloat(amount),
         parseFloat(tax_rate) || 0,
         'cash', dbStatus,
         new Date().toISOString().slice(0,10), '');

  _audit(req.user.id, `FATURA ${num} — ${p.first_name} ${p.last_name} ₺${amount}`, req);
  const inv = db.prepare(`SELECT i.*,p.first_name,p.last_name FROM invoices i
    JOIN patients p ON p.id=i.patient_id WHERE i.id=?`).get(id);
  res.status(201).json(fmt(inv));
});

// PUT /api/invoices/:id  — frontend: {status:'paid'} body ile gönderir
router.put('/:id', (req, res) => {
  const inv = db.prepare('SELECT * FROM invoices WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!inv) return res.status(404).json({ error: 'Fatura bulunamadı.' });
  const { status } = req.body;
  if (!status) return res.status(400).json({ error: 'Status zorunludur.' });
  db.prepare("UPDATE invoices SET status=? WHERE id=?").run(status.toUpperCase(), req.params.id);
  _audit(req.user.id, `FATURA GÜNCELLENDİ ${inv.number} → ${status}`, req);
  const updated = db.prepare(`SELECT i.*,p.first_name,p.last_name FROM invoices i
    JOIN patients p ON p.id=i.patient_id WHERE i.id=?`).get(req.params.id);
  res.json(fmt(updated));
});

// DELETE /api/invoices/:id
router.delete('/:id', (req, res) => {
  if (!db.prepare('SELECT id FROM invoices WHERE id=? AND user_id=?').get(req.params.id, req.user.id))
    return res.status(404).json({ error: 'Bulunamadı.' });
  db.prepare('DELETE FROM invoices WHERE id=? AND user_id=?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

module.exports = router;
