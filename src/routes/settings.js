// src/routes/settings.js
// Dashboard: frontend okur: dash.totalPatients, dash.todayCount, dash.monthSessions, dash.riskPatients, dash.monthRevenue
const router = require('express').Router();
const db     = require('../db/database');
const auth   = require('../middleware/auth');
const { _audit, _safeUser } = require('./auth');

router.use(auth);

// GET /api/settings
router.get('/', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  res.json(_safeUser(u));
});

// PUT /api/settings
router.put('/', (req, res) => {
  const { name, clinicName, clinicAddr, clinicPhone, therapies, prices } = req.body;
  db.prepare(`UPDATE users SET
    name=COALESCE(?,name),
    clinic_name=COALESCE(?,clinic_name),
    clinic_addr=COALESCE(?,clinic_addr),
    clinic_phone=COALESCE(?,clinic_phone),
    therapies=COALESCE(?,therapies),
    prices=COALESCE(?,prices),
    updated_at=datetime('now')
    WHERE id=?`)
    .run(
      name||null, clinicName||null, clinicAddr||null, clinicPhone||null,
      therapies ? JSON.stringify(therapies) : null,
      prices    ? JSON.stringify(prices)    : null,
      req.user.id
    );
  _audit(req.user.id, 'AYARLAR GÜNCELLENDİ', req);
  res.json(_safeUser(db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id)));
});

// GET /api/settings/audit  — KVKK denetim izi
router.get('/audit', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const logs  = db.prepare(
    'SELECT action,created_at,ip FROM audit_log WHERE user_id=? ORDER BY created_at DESC LIMIT ?'
  ).all(req.user.id, limit);
  res.json(logs);
});

// GET /api/settings/dashboard
// frontend okur: totalPatients, todayCount, monthSessions, monthRevenue, riskPatients, trend, thyDist
router.get('/dashboard', (req, res) => {
  const uid   = req.user.id;
  const today = new Date().toISOString().slice(0,10);
  const month = today.slice(0,7);

  const totalPatients = db.prepare(
    "SELECT COUNT(*) v FROM patients WHERE user_id=?"
  ).get(uid).v;

  const todayCount = db.prepare(
    "SELECT COUNT(*) v FROM appointments WHERE user_id=? AND date(at_time)=?"
  ).get(uid, today).v;

  const monthSessions = db.prepare(
    "SELECT COUNT(*) v FROM appointments WHERE user_id=? AND lower(status)='completed' AND at_time LIKE ?"
  ).get(uid, month+'%').v;

  const monthRevenue = db.prepare(
    "SELECT COALESCE(SUM(amount),0) v FROM invoices WHERE user_id=? AND lower(status)='paid' AND date LIKE ?"
  ).get(uid, month+'%').v;

  // PHQ9 >= 15 → yüksek risk
  const riskPatients = db.prepare(`
    SELECT p.id, p.first_name fn, p.last_name ln, s.score last_phq9
    FROM patients p
    JOIN scores s ON s.patient_id=p.id AND s.scale='PHQ9'
    WHERE p.user_id=?
      AND s.created_at=(SELECT MAX(created_at) FROM scores WHERE patient_id=p.id AND scale='PHQ9')
      AND s.score>=15
    ORDER BY s.score DESC
  `).all(uid);

  // Son 6 aylık tamamlanan seans trendi
  const trend = db.prepare(`
    SELECT strftime('%Y-%m', at_time) m, COUNT(*) cnt
    FROM appointments WHERE user_id=? AND lower(status)='completed'
    GROUP BY m ORDER BY m DESC LIMIT 6
  `).all(uid).reverse();

  // Terapi türü dağılımı
  const thyDist = db.prepare(`
    SELECT therapy, COUNT(*) cnt FROM appointments
    WHERE user_id=? AND lower(status)='completed'
    GROUP BY therapy ORDER BY cnt DESC
  `).all(uid);

  res.json({ totalPatients, todayCount, monthSessions, monthRevenue, riskPatients, trend, thyDist });
});

module.exports = router;
