// src/routes/notes.js
// Frontend gönderir: {patient_id, content_enc, session_date, therapy_type, mood, homework, duration}
const router = require('express').Router();
const { v4: uuid } = require('uuid');
const db   = require('../db/database');
const auth = require('../middleware/auth');
const { _audit } = require('./auth');

router.use(auth);

function fmt(n) {
  return {
    id:           n.id,
    patient_id:   n.patient_id,
    session_no:   n.session_no,
    session_date: n.date,
    therapy_type: n.therapy,
    content_enc:  n.content_enc,
    mood:         n.mood,
    homework:     n.homework,
    duration:     n.duration,
    created_at:   n.created_at,
  };
}

// GET /api/notes?patient_id=xxx
router.get('/', (req, res) => {
  const { patient_id } = req.query;
  if (!patient_id) return res.status(400).json({ error: 'patient_id zorunludur.' });
  if (!db.prepare('SELECT id FROM patients WHERE id=? AND user_id=?').get(patient_id, req.user.id))
    return res.status(403).json({ error: 'Erişim reddedildi.' });
  res.json(db.prepare('SELECT * FROM session_notes WHERE patient_id=? ORDER BY session_no DESC').all(patient_id).map(fmt));
});

// GET /api/notes/:id  — tek not detayı
router.get('/:id', (req, res) => {
  const n = db.prepare('SELECT * FROM session_notes WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!n) return res.status(404).json({ error: 'Not bulunamadı.' });
  res.json(fmt(n));
});

// POST /api/notes
// frontend: {patient_id, content_enc, session_date, therapy_type, mood, homework, duration}
router.post('/', (req, res) => {
  const { patient_id, content_enc, session_date, therapy_type, mood, homework, duration } = req.body;
  if (!patient_id || !content_enc)
    return res.status(400).json({ error: 'Hasta ve şifreli içerik zorunludur.' });

  const p = db.prepare('SELECT first_name,last_name FROM patients WHERE id=? AND user_id=?').get(patient_id, req.user.id);
  if (!p) return res.status(403).json({ error: 'Erişim reddedildi.' });

  const last = db.prepare('SELECT MAX(session_no) mx FROM session_notes WHERE patient_id=?').get(patient_id);
  const sno  = (last?.mx || 0) + 1;
  const id   = uuid();

  db.prepare(`INSERT INTO session_notes (id,user_id,patient_id,session_no,date,therapy,content_enc,mood,homework,duration)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, req.user.id, patient_id, sno,
         session_date || new Date().toISOString().slice(0,10),
         therapy_type || 'BDT', content_enc,
         mood || 'neutral', homework || '', duration || 50);

  _audit(req.user.id, `SEANS NOTU — ${p.first_name} ${p.last_name} Seans #${sno}`, req);
  res.status(201).json(fmt(db.prepare('SELECT * FROM session_notes WHERE id=?').get(id)));
});

// DELETE /api/notes/:id
router.delete('/:id', (req, res) => {
  if (!db.prepare('SELECT id FROM session_notes WHERE id=? AND user_id=?').get(req.params.id, req.user.id))
    return res.status(404).json({ error: 'Bulunamadı.' });
  db.prepare('DELETE FROM session_notes WHERE id=? AND user_id=?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

module.exports = router;
