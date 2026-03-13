'use strict';
const https = require('https');
const { query } = require('../db');

const NETGSM_USER = process.env.NETGSM_USER;
const NETGSM_PASS = process.env.NETGSM_PASS;
const NETGSM_HEADER = process.env.NETGSM_HEADER || 'DISSEANSIM';

// ── Format Turkish phone ─────────────────────────────────────────────────
function formatPhone(phone) {
  if (!phone) return null;
  let p = phone.replace(/\D/g, '');
  if (p.startsWith('0')) p = '90' + p.slice(1);
  if (p.startsWith('5')) p = '90' + p;
  if (!p.startsWith('90') || p.length !== 12) return null;
  return p;
}

// ── Send single SMS via NetGSM ───────────────────────────────────────────
async function sendSMS(phone, message) {
  if (!NETGSM_USER || !NETGSM_PASS) {
    console.log('[SMS MOCK]', phone, ':', message.slice(0, 60));
    return { success: true, mock: true };
  }

  const formatted = formatPhone(phone);
  if (!formatted) return { success: false, error: 'Geçersiz telefon numarası' };

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<mainbody>
  <header>
    <company dil="TR">Netgsm</company>
    <usercode>${NETGSM_USER}</usercode>
    <password>${NETGSM_PASS}</password>
    <type>1:n</type>
    <msgheader>${NETGSM_HEADER}</msgheader>
  </header>
  <body>
    <msg><![CDATA[${message}]]></msg>
    <no>${formatted}</no>
  </body>
</mainbody>`;

  return new Promise((resolve) => {
    const postData = 'xml=' + encodeURIComponent(xml);
    const options = {
      hostname: 'api.netgsm.com.tr',
      port: 443,
      path: '/sms/send/xml',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const code = data.trim().split(' ')[0];
        if (['00','01','02'].includes(code)) {
          resolve({ success: true, code });
        } else {
          resolve({ success: false, error: 'NetGSM hata kodu: ' + code });
        }
      });
    });
    req.on('error', (e) => resolve({ success: false, error: e.message }));
    req.write(postData);
    req.end();
  });
}

// ── Appointment reminder SMS ──────────────────────────────────────────────
async function sendAppointmentReminder(appointment) {
  const { first_name, last_name, phone, starts_at, type, doctor_name, clinic_name } = appointment;
  if (!phone) return { success: false, error: 'Telefon yok' };

  const dateStr = new Date(starts_at).toLocaleDateString('tr-TR', {
    weekday: 'long', day: 'numeric', month: 'long'
  });
  const timeStr = new Date(starts_at).toLocaleTimeString('tr-TR', {
    hour: '2-digit', minute: '2-digit'
  });

  const msg = `Sayin ${first_name} ${last_name}, ${dateStr} saat ${timeStr} icin ${clinic_name || 'klinigimizdeki'} ${type || 'randevunuzu'} hatirlatiyoruz. ${doctor_name ? doctor_name + ' ile.' : ''} Degisiklik icin lutfen arayin.`;

  const result = await sendSMS(phone, msg);

  // Log to notifications table
  try {
    await query(
      `INSERT INTO notifications (tenant_id, patient_id, type, title, body, channel, status, sent_at)
       VALUES ($1, $2, 'appointment_reminder', 'Randevu Hatirlatmasi', $3, 'sms', $4, NOW())`,
      [appointment.tenant_id, appointment.patient_id, msg, result.success ? 'sent' : 'failed']
    );
  } catch (e) { /* non-fatal */ }

  return result;
}

// ── Bulk send reminders for tomorrow ─────────────────────────────────────
async function sendTomorrowReminders() {
  try {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const dateStr = tomorrow.toISOString().slice(0, 10);

    const apts = await query(
      `SELECT a.id, a.starts_at, a.type, a.tenant_id, a.patient_id,
              p.first_name, p.last_name, p.phone,
              u.name as doctor_name, t.name as clinic_name
       FROM appointments a
       JOIN patients p ON p.id = a.patient_id
       JOIN users u ON u.id = a.doctor_id
       JOIN tenants t ON t.id = a.tenant_id
       WHERE a.starts_at::date = $1
         AND a.status = 'scheduled'
         AND a.reminder_sent = false`,
      [dateStr]
    );

    let sent = 0, failed = 0;
    for (const apt of apts.rows) {
      const r = await sendAppointmentReminder(apt);
      if (r.success) {
        await query('UPDATE appointments SET reminder_sent = true WHERE id = $1', [apt.id]);
        sent++;
      } else {
        failed++;
        console.error('[SMS] Reminder failed:', apt.id, r.error);
      }
      // Rate limit: 10/sec
      await new Promise(res => setTimeout(res, 100));
    }

    console.log(`[SMS Reminder] ${dateStr}: ${sent} sent, ${failed} failed`);
    return { sent, failed };
  } catch (err) {
    console.error('[SMS Reminder] Error:', err.message);
    return { sent: 0, failed: 0, error: err.message };
  }
}

module.exports = { sendSMS, sendAppointmentReminder, sendTomorrowReminders, formatPhone };
