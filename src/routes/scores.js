// src/routes/scores.js
// Frontend gönderir: {patient_id, scale, total_score, answers}
// Frontend okur: s.total_score
const router = require('express').Router();
const { v4: uuid } = require('uuid');
const db   = require('../db/database');
const auth = require('../middleware/auth');
const { _audit } = require('./auth');

router.use(auth);

function fmt(s) {
  return {
    id:          s.id,
    patient_id:  s.patient_id,
    scale:       s.scale,
    total_score: s.score,   // frontend total_score bekler
    answers:     s.answers,
    date:        s.date,
    created_at:  s.created_at,
  };
}

// GET /api/scores?patient_id=xxx&scale=PHQ9
router.get('/', (req, res) => {
  const { patient_id, scale } = req.query;
  if (!patient_id) return res.status(400).json({ error: 'patient_id zorunludur.' });
  if (!db.prepare('SELECT id FROM patients WHERE id=? AND user_id=?').get(patient_id, req.user.id))
    return res.status(403).json({ error: 'Erişim reddedildi.' });
  let sql = 'SELECT * FROM scores WHERE patient_id=?';
  const p = [patient_id];
  if (scale) { sql += ' AND scale=?'; p.push(scale); }
  sql += ' ORDER BY date ASC, created_at ASC';
  res.json(db.prepare(sql).all(...p).map(fmt));
});

// POST /api/scores
// frontend: {patient_id, scale, total_score, answers}
router.post('/', (req, res) => {
  const { patient_id, scale, total_score, answers } = req.body;
  if (!patient_id || !scale || total_score == null)
    return res.status(400).json({ error: 'Hasta, ölçek ve toplam puan zorunludur.' });

  const p = db.prepare('SELECT first_name,last_name FROM patients WHERE id=? AND user_id=?').get(patient_id, req.user.id);
  if (!p) return res.status(403).json({ error: 'Erişim reddedildi.' });

  const id = uuid();
  db.prepare('INSERT INTO scores (id,user_id,patient_id,scale,score,answers,date) VALUES (?,?,?,?,?,?,?)')
    .run(id, req.user.id, patient_id, scale, total_score,
         typeof answers === 'string' ? answers : JSON.stringify(answers||[]),
         new Date().toISOString().slice(0,10));

  _audit(req.user.id, `ÖLÇEK — ${p.first_name} ${p.last_name} ${scale}=${total_score}`, req);
  res.status(201).json(fmt(db.prepare('SELECT * FROM scores WHERE id=?').get(id)));
});

// DELETE /api/scores/:id
router.delete('/:id', (req, res) => {
  if (!db.prepare('SELECT id FROM scores WHERE id=? AND user_id=?').get(req.params.id, req.user.id))
    return res.status(404).json({ error: 'Bulunamadı.' });
  db.prepare('DELETE FROM scores WHERE id=? AND user_id=?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

module.exports = router;
