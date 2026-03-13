'use strict';
const nodemailer = require('nodemailer');

function getTransport() {
  if (process.env.SMTP_HOST) {
    return nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });
  }
  // Dev: ethereal mock
  return nodemailer.createTransport({ jsonTransport: true });
}

async function sendAppointmentReminderEmail(appointment) {
  if (!appointment.email) return { success: false, error: 'E-posta yok' };
  const transport = getTransport();
  const d = new Date(appointment.starts_at);
  const dateStr = d.toLocaleDateString('tr-TR', { weekday:'long', day:'numeric', month:'long' });
  const timeStr = d.toLocaleTimeString('tr-TR', { hour:'2-digit', minute:'2-digit' });
  try {
    await transport.sendMail({
      from: `"${appointment.clinic_name || 'DişSeansım'}" <${process.env.SMTP_FROM || 'hatirlatma@disseansim.com'}>`,
      to: appointment.email,
      subject: `Randevu Hatırlatması — ${dateStr} ${timeStr}`,
      html: `
        <div style="font-family:system-ui,sans-serif;max-width:500px;margin:0 auto;background:#f8f7f4;padding:24px;border-radius:12px">
          <div style="background:#0E1C1F;border-radius:8px;padding:16px 20px;margin-bottom:20px">
            <span style="color:#2ECAD8;font-size:20px;font-weight:700">🦷 DişSeansım</span>
          </div>
          <h2 style="color:#132D32;margin:0 0 12px">Randevu Hatırlatması</h2>
          <p style="color:#555;line-height:1.7">Sayın <strong>${appointment.first_name} ${appointment.last_name}</strong>,</p>
          <p style="color:#555;line-height:1.7">Yarın kliniğimizde randevunuz bulunmaktadır:</p>
          <div style="background:#fff;border-left:4px solid #2ECAD8;padding:16px;border-radius:0 8px 8px 0;margin:16px 0">
            <div style="font-size:22px;font-weight:700;color:#132D32">${dateStr}</div>
            <div style="font-size:18px;color:#2ECAD8;font-weight:600">${timeStr}</div>
            <div style="color:#666;margin-top:6px">${appointment.type || 'Diş Tedavisi'}${appointment.doctor_name ? ' · ' + appointment.doctor_name : ''}</div>
          </div>
          <p style="color:#555;font-size:13px">Randevunuzu iptal etmek veya değiştirmek için lütfen kliniğimizi arayın.</p>
          <hr style="border:none;border-top:1px solid #ddd;margin:20px 0">
          <p style="color:#999;font-size:11px;text-align:center">${appointment.clinic_name || 'DişSeansım'} · Bu e-posta otomatik gönderilmiştir.</p>
        </div>`
    });
    return { success: true };
  } catch (e) { return { success: false, error: e.message }; }
}

async function sendWelcomeEmail(user, clinicName) {
  if (!user.email) return;
  const transport = getTransport();
  try {
    await transport.sendMail({
      from: `"DişSeansım" <${process.env.SMTP_FROM || 'merhaba@disseansim.com'}>`,
      to: user.email,
      subject: 'DişSeansım\'a Hoş Geldiniz 🦷',
      html: `
        <div style="font-family:system-ui,sans-serif;max-width:500px;margin:0 auto">
          <h1 style="color:#132D32">Hoş Geldiniz, ${user.name}!</h1>
          <p style="color:#555;line-height:1.7">${clinicName || 'Kliniğiniz'} için DişSeansım hesabınız başarıyla oluşturuldu. 14 günlük ücretsiz deneme süreniz başladı.</p>
          <a href="${process.env.FRONTEND_URL || 'https://disseansim.com'}/app.html" style="display:inline-block;background:#2ECAD8;color:#0C1E22;padding:12px 24px;border-radius:8px;font-weight:700;text-decoration:none">Uygulamaya Git →</a>
        </div>`
    });
  } catch (e) { console.error('Welcome email error:', e.message); }
}

module.exports = { sendAppointmentReminderEmail, sendWelcomeEmail };
