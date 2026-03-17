// src/routes/packages.js
// Frontend gönderir: {patient_id, name, sessions_total, price}
// Frontend okur: p.sessions_total, p.used
// Frontend çağırır: PUT /packages/:id/use
const router = require('express').Router();
const { v4: uuid } = require('uuid');
const db   = require('../db/database');
const auth = require('../middleware/auth');
const { _audit } = require('./auth');

router.use(auth);

function fmt(pk) {
  return {
    id:             pk.id,
    patient_id:     pk.patient_id,
    name:           pk.name || `${pk.sessions} Seans Paketi`,
    sessions_total: pk.sessions,   // frontend sessions_total bekler
    used:           pk.used || 0,
    remaining:      (pk.sessions || 0) - (pk.used || 0),
    price:          pk.price || 0,
    start_date:     pk.start_date,
    payment_note:   pk.payment_note,
    // JOIN'den
    fn:             pk.first_name,
    ln:             pk.last_name,
    color:          pk.color,
    created_at:     pk.created_at,
  };
}

// GET /api/packages
router.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT pk.*, p.first_name, p.last_name, p.color
    FROM packages pk JOIN patients p ON p.id=pk.patient_id
    WHERE pk.user_id=? ORDER BY pk.created_at DESC
  `).all(req.user.id);
  res.json(rows.map(fmt));
});

// POST /api/packages
// frontend: {patient_id, name, sessions_total, price}
router.post('/', (req, res) => {
  const { patient_id, name, sessions_total, price } = req.body;
  if (!patient_id || !sessions_total)
    return res.status(400).json({ error: 'Hasta ve seans sayısı zorunludur.' });

  const p = db.prepare('SELECT first_name,last_name FROM patients WHERE id=? AND user_id=?').get(patient_id, req.user.id);
  if (!p) return res.status(403).json({ error: 'Hasta bulunamadı.' });

  const id = uuid();
  db.prepare(`INSERT INTO packages (id,user_id,patient_id,name,sessions,used,price,start_date,payment_note)
    VALUES (?,?,?,?,?,0,?,?,?)`)
    .run(id, req.user.id, patient_id,
         name || `${sessions_total} Seans Paketi`,
         parseInt(sessions_total),
         parseFloat(price) || 0,
         new Date().toISOString().slice(0,10), '');

  _audit(req.user.id, `PAKET OLUŞTURULDU — ${p.first_name} ${p.last_name} ${sessions_total} Seans`, req);
  const pk = db.prepare(`SELECT pk.*,p.first_name,p.last_name,p.color FROM packages pk
    JOIN patients p ON p.id=pk.patient_id WHERE pk.id=?`).get(id);
  res.status(201).json(fmt(pk));
});

// PUT /api/packages/:id/use  — seans kullan (+1)
router.put('/:id/use', (req, res) => {
  const pk = db.prepare('SELECT * FROM packages WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!pk) return res.status(404).json({ error: 'Paket bulunamadı.' });
  if (pk.used >= pk.sessions) return res.status(400).json({ error: 'Paketin tüm seansları kullanıldı.' });
  db.prepare("UPDATE packages SET used=used+1, updated_at=datetime('now') WHERE id=?").run(req.params.id);
  const updated = db.prepare(`SELECT pk.*,p.first_name,p.last_name,p.color FROM packages pk
    JOIN patients p ON p.id=pk.patient_id WHERE pk.id=?`).get(req.params.id);
  res.json(fmt(updated));
});

// DELETE /api/packages/:id
router.delete('/:id', (req, res) => {
  if (!db.prepare('SELECT id FROM packages WHERE id=? AND user_id=?').get(req.params.id, req.user.id))
    return res.status(404).json({ error: 'Bulunamadı.' });
  db.prepare('DELETE FROM packages WHERE id=? AND user_id=?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

module.exports = router;
