'use strict';
const router = require('express').Router();
const { authMiddleware, tenantMiddleware, can } = require('../middleware/auth');
const { query } = require('../db');
const { sendAppointmentReminderEmail, sendWelcomeEmail } = require('../services/email');

router.use(authMiddleware, tenantMiddleware);

// ── GET /api/email/history — son 50 gönderim logu ──────────────────────
router.get('/history', can('settings.manage'), async (req, res) => {
  try {
    const r = await query(
      `SELECT id, type, title, body, channel, status, created_at
       FROM notifications
       WHERE tenant_id=$1 AND channel IN ('email','sms_email')
       ORDER BY created_at DESC LIMIT 50`,
      [req.tenantId]
    );
    res.json({ history: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/email/send — manuel e-posta gönder ────────────────────────
router.post('/send', can('appointment.write'), async (req, res) => {
  try {
    const { patientId, subject, body, type } = req.body;
    if (!patientId || !subject || !body) {
      return res.status(400).json({ error: 'patientId, subject ve body gerekli' });
    }
    const patient = await query(
      'SELECT id, first_name, last_name, email FROM patients WHERE id=$1 AND tenant_id=$2',
      [patientId, req.tenantId]
    );
    if (!patient.rows.length) return res.status(404).json({ error: 'Hasta bulunamadı' });
    const p = patient.rows[0];
    if (!p.email) return res.status(400).json({ error: 'Hastanın e-posta adresi yok' });

    const { sendAppointmentReminderEmail } = require('../services/email');
    const result = await sendAppointmentReminderEmail({
      email: p.email,
      first_name: p.first_name,
      last_name: p.last_name,
      custom_subject: subject,
      custom_body: body,
    });

    await query(
      `INSERT INTO notifications (tenant_id, type, title, body, channel, status)
       VALUES ($1, $2, $3, $4, 'email', $5)`,
      [req.tenantId, type || 'manual', subject, body, result.success ? 'sent' : 'failed']
    );

    if (!result.success) return res.status(502).json({ error: 'E-posta gönderilemedi: ' + result.error });
    res.json({ success: true, to: p.email });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/email/remind/:appointmentId — randevu e-posta hatırlatması ──
router.post('/remind/:appointmentId', can('appointment.write'), async (req, res) => {
  try {
    const apt = await query(
      `SELECT a.*, p.first_name, p.last_name, p.email, p.phone,
              u.name as doctor_name, t.name as clinic_name
       FROM appointments a
       JOIN patients p ON p.id=a.patient_id
       JOIN users u ON u.id=a.doctor_id
       JOIN tenants t ON t.id=a.tenant_id
       WHERE a.id=$1 AND a.tenant_id=$2`,
      [req.params.appointmentId, req.tenantId]
    );
    if (!apt.rows.length) return res.status(404).json({ error: 'Randevu bulunamadı' });
    const a = apt.rows[0];
    if (!a.email) return res.status(400).json({ error: 'Hastanın e-posta adresi yok' });

    const result = await sendAppointmentReminderEmail(a);
    res.json({ success: result.success, to: a.email, error: result.error });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/email/send-reminders — tüm yarınki randevulara e-posta ────
router.post('/send-reminders', can('appointment.write'), async (req, res) => {
  try {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const dateStr = tomorrow.toISOString().slice(0, 10);

    const apts = await query(
      `SELECT a.*, p.first_name, p.last_name, p.email, p.phone,
              u.name as doctor_name, t.name as clinic_name
       FROM appointments a
       JOIN patients p ON p.id=a.patient_id
       JOIN users u ON u.id=a.doctor_id
       JOIN tenants t ON t.id=a.tenant_id
       WHERE a.tenant_id=$1
         AND a.starts_at::date=$2
         AND a.status='scheduled'
         AND p.email IS NOT NULL`,
      [req.tenantId, dateStr]
    );

    let sent = 0, failed = 0;
    for (const apt of apts.rows) {
      const result = await sendAppointmentReminderEmail(apt);
      if (result.success) sent++; else failed++;
    }
    res.json({ sent, failed, total: apts.rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
