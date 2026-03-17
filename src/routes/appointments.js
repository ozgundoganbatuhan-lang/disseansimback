// src/routes/appointments.js
const router = require('express').Router();
const { v4: uuid } = require('uuid');
const db   = require('../db/database');
const auth = require('../middleware/auth');
const { _audit } = require('./auth');
const { syncToGcal, deleteFromGcal } = require('../services/googleCalendar');

router.use(auth);

// Frontend'den gelen appointment satırını normalize et
function fmt(a) {
  if (!a) return null;
  return {
    id:           a.id,
    patient_id:   a.patient_id,
    at_time:      a.at_time,
    duration:     a.duration,
    therapy_type: a.therapy,
    status:       (a.status||'scheduled').toLowerCase(),
    medium:       a.medium,
    notes:        a.note,
    gcal_synced:  !!a.gcal_event_id,
    // JOIN'den gelen hasta bilgileri
    fn:           a.first_name,
    ln:           a.last_name,
    color:        a.color,
    created_at:   a.created_at,
  };
}

// GET /api/appointments
router.get('/', (req, res) => {
  const { date, status, patient_id, from, to } = req.query;
  let sql = `SELECT a.*, p.first_name, p.last_name, p.color
    FROM appointments a JOIN patients p ON p.id=a.patient_id
    WHERE a.user_id=?`;
  const p = [req.user.id];
  if (date)       { sql += ' AND date(a.at_time)=?'; p.push(date); }
  if (status)     { sql += ' AND lower(a.status)=?'; p.push(status.toLowerCase()); }
  if (patient_id) { sql += ' AND a.patient_id=?'; p.push(patient_id); }
  if (from)       { sql += ' AND a.at_time>=?'; p.push(from); }
  if (to)         { sql += ' AND a.at_time<=?'; p.push(to); }
  sql += ' ORDER BY a.at_time DESC';
  res.json(db.prepare(sql).all(...p).map(fmt));
});

// GET /api/appointments/today  — dashboard için
router.get('/today', (req, res) => {
  const today = new Date().toISOString().slice(0,10);
  res.json(db.prepare(`
    SELECT a.*, p.first_name, p.last_name, p.color
    FROM appointments a JOIN patients p ON p.id=a.patient_id
    WHERE a.user_id=? AND date(a.at_time)=?
    ORDER BY a.at_time ASC
  `).all(req.user.id, today).map(fmt));
});

// POST /api/appointments
// frontend: {patient_id, at_time, duration, therapy_type, notes}
router.post('/', async (req, res) => {
  const { patient_id, at_time, duration, therapy_type, notes } = req.body;
  if (!patient_id || !at_time)
    return res.status(400).json({ error: 'Hasta ve randevu saati zorunludur.' });

  const p = db.prepare('SELECT * FROM patients WHERE id=? AND user_id=?').get(patient_id, req.user.id);
  if (!p) return res.status(403).json({ error: 'Hasta bulunamadı.' });

  const id = uuid();
  db.prepare(`INSERT INTO appointments (id,user_id,patient_id,therapy,at_time,duration,status,medium,note)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, req.user.id, patient_id, therapy_type||p.therapy||'BDT',
         at_time, duration||50, 'SCHEDULED', 'face', notes||'');

  // Google Calendar senkronizasyonu
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (user.gcal_tokens) {
    try {
      const evt = await syncToGcal(user, {
        id, patientName: `${p.first_name} ${p.last_name}`,
        therapy: therapy_type||'BDT', atTime: at_time,
        duration: duration||50, medium: 'face', note: notes||''
      });
      if (evt?.id) db.prepare("UPDATE appointments SET gcal_event_id=? WHERE id=?").run(evt.id, id);
    } catch(e) { console.error('GCal sync:', e.message); }
  }

  _audit(req.user.id, `RANDEVU OLUŞTURULDU — ${p.first_name} ${p.last_name} ${at_time.slice(0,16)}`, req);
  const apt = db.prepare(`SELECT a.*,p.first_name,p.last_name,p.color FROM appointments a
    JOIN patients p ON p.id=a.patient_id WHERE a.id=?`).get(id);
  res.status(201).json(fmt(apt));
});

// PUT /api/appointments/:id
// frontend: {at_time, duration, therapy_type, notes, status}
router.put('/:id', async (req, res) => {
  const a = db.prepare('SELECT * FROM appointments WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!a) return res.status(404).json({ error: 'Randevu bulunamadı.' });

  const { at_time, duration, therapy_type, notes, status } = req.body;
  // status: frontend 'completed'/'scheduled'/'cancelled' → DB uppercase
  const dbStatus = status ? status.toUpperCase() : a.status;

  db.prepare(`UPDATE appointments SET
    at_time=COALESCE(?,at_time), duration=COALESCE(?,duration),
    therapy=COALESCE(?,therapy), note=COALESCE(?,note),
    status=?, updated_at=datetime('now') WHERE id=?`)
    .run(at_time||null, duration||null, therapy_type||null, notes||null,
         dbStatus, req.params.id);

  // Tamamlandıysa → paket sayacı artır
  if (dbStatus === 'COMPLETED' && a.status !== 'COMPLETED') {
    db.prepare(`UPDATE packages SET used=MIN(used+1,sessions), updated_at=datetime('now')
      WHERE patient_id=? AND user_id=? AND used<sessions`).run(a.patient_id, req.user.id);
    _audit(req.user.id, `SEANS TAMAMLANDI — ${req.params.id}`, req);
  }

  // GCal güncelle
  if (at_time || therapy_type) {
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
    if (user.gcal_tokens && a.gcal_event_id) {
      const p = db.prepare('SELECT * FROM patients WHERE id=?').get(a.patient_id);
      try {
        await syncToGcal(user, {
          id: req.params.id, eventId: a.gcal_event_id,
          patientName: `${p.first_name} ${p.last_name}`,
          therapy: therapy_type||a.therapy, atTime: at_time||a.at_time,
          duration: duration||a.duration, medium: a.medium, note: notes||a.note
        });
      } catch(e) { console.error('GCal update:', e.message); }
    }
  }

  const updated = db.prepare(`SELECT a.*,p.first_name,p.last_name,p.color FROM appointments a
    JOIN patients p ON p.id=a.patient_id WHERE a.id=?`).get(req.params.id);
  res.json(fmt(updated));
});

// DELETE /api/appointments/:id
router.delete('/:id', async (req, res) => {
  const a = db.prepare('SELECT * FROM appointments WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!a) return res.status(404).json({ error: 'Bulunamadı.' });
  if (a.gcal_event_id) {
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
    if (user.gcal_tokens) { try { await deleteFromGcal(user, a.gcal_event_id); } catch(_) {} }
  }
  db.prepare('DELETE FROM appointments WHERE id=? AND user_id=?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

module.exports = router;
