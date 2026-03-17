// src/routes/calendar.js
const router = require('express').Router();
const db   = require('../db/database');
const auth = require('../middleware/auth');
const { _audit } = require('./auth');
const gcal = require('../services/googleCalendar');

// GET /api/calendar/connect  — OAuth başlat
router.get('/connect', auth, (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID)
    return res.status(501).json({ error: 'Google Calendar entegrasyonu yapılandırılmamış.' });
  // state token = userId (basit)
  const url = gcal.getAuthUrl(req.user.id);
  res.json({ url });
});

// GET /api/calendar/callback  — OAuth callback (browser redirect)
router.get('/callback', async (req, res) => {
  const { code, state: userId, error } = req.query;
  const FRONTEND = process.env.FRONTEND_URL || 'http://localhost:3000';

  if (error || !code || !userId) {
    return res.redirect(`${FRONTEND}/app.html?gcal=error&msg=${encodeURIComponent(error||'İzin reddedildi')}`);
  }

  try {
    await gcal.handleCallback(code, userId);
    _audit(userId, 'GOOGLE CALENDAR BAĞLANDI', req);
    res.redirect(`${FRONTEND}/app.html?gcal=success`);
  } catch(e) {
    console.error('GCal callback error:', e.message);
    res.redirect(`${FRONTEND}/app.html?gcal=error&msg=${encodeURIComponent(e.message)}`);
  }
});

// GET /api/calendar/status
router.get('/status', auth, (req, res) => {
  const u = db.prepare('SELECT gcal_tokens, gcal_id FROM users WHERE id=?').get(req.user.id);
  res.json({ connected: !!u?.gcal_tokens, calendarId: u?.gcal_id || null });
});

// GET /api/calendar/upcoming  — GCal'dan etkinlikleri çek
router.get('/upcoming', auth, async (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (!u.gcal_tokens) return res.status(400).json({ error: 'Google Calendar bağlı değil.' });
  try {
    const events = await gcal.fetchUpcoming(u, parseInt(req.query.days)||30);
    res.json(events);
  } catch(e) {
    console.error('GCal fetch error:', e.message);
    res.status(500).json({ error: 'Google Calendar verileri alınamadı.' });
  }
});

// DELETE /api/calendar/disconnect
router.delete('/disconnect', auth, async (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (!u.gcal_tokens) return res.json({ ok: true });
  try { await gcal.revokeAccess(u); } catch(_) {}
  _audit(req.user.id, 'GOOGLE CALENDAR BAĞLANTISI KESİLDİ', req);
  res.json({ ok: true });
});

module.exports = router;
