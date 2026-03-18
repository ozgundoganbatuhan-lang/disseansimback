'use strict';
const router = require('express').Router();
const { authMiddleware, tenantMiddleware, can } = require('../middleware/auth');
const { sendSMS, sendAppointmentReminder, sendTomorrowReminders } = require('../services/sms');
const { query } = require('../db');

router.use(authMiddleware, tenantMiddleware);

// Send manual SMS to a patient
router.post('/send', can('appointment.write'), async (req, res) => {
  try {
    const { phone, message, patient_id } = req.body;
    if (!phone || !message) return res.status(400).json({ error: 'Telefon ve mesaj zorunlu' });
    if (message.length > 480) return res.status(400).json({ error: 'Mesaj 480 karakterden uzun olamaz' });

    const r = await sendSMS(phone, message);

    if (patient_id) {
      await query(
        `INSERT INTO notifications (tenant_id, patient_id, type, title, body, channel, status, sent_at)
         VALUES ($1, $2, 'manual_sms', 'Manuel SMS', $3, 'sms', $4, NOW())`,
        [req.tenantId, patient_id, message, r.success ? 'sent' : 'failed']
      );
    }

    res.json(r);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manually trigger tomorrow's reminders (for testing)
router.post('/send-reminders', can('settings.manage'), async (req, res) => {
  try {
    const result = await sendTomorrowReminders();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Send appointment reminder for a specific appointment
router.post('/remind/:appointmentId', can('appointment.write'), async (req, res) => {
  try {
    const apt = await query(
      `SELECT a.*, p.first_name, p.last_name, p.phone, u.name as doctor_name, t.name as clinic_name
       FROM appointments a
       JOIN patients p ON p.id = a.patient_id
       JOIN users u ON u.id = a.doctor_id
       JOIN tenants t ON t.id = a.tenant_id
       WHERE a.id=$1 AND a.tenant_id=$2`,
      [req.params.appointmentId, req.tenantId]
    );
    if (!apt.rows.length) return res.status(404).json({ error: 'Randevu bulunamadı' });
    const r = await sendAppointmentReminder(apt.rows[0]);
    if (r.success) await query('UPDATE appointments SET reminder_sent=true WHERE id=$1', [req.params.appointmentId]);
    res.json(r);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get SMS notification history
router.get('/history', async (req, res) => {
  try {
    const r = await query(
      `SELECT n.*, CONCAT(p.first_name, ' ', p.last_name) AS patient_name FROM notifications n
       LEFT JOIN patients p ON p.id = n.patient_id
       WHERE n.tenant_id=$1 AND n.channel='sms'
       ORDER BY n.created_at DESC LIMIT 100`,
      [req.tenantId]
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
