'use strict';
const cron = require('node-cron');
const { sendTomorrowReminders } = require('./sms');
const { sendAppointmentReminderEmail } = require('./email');
const { query } = require('../db');

let started = false;

function startScheduler() {
  if (started) return;
  started = true;
  console.log('⏰ Scheduler başlatıldı');

  // ── Randevu hatırlatmaları — her gün 10:00'da ────────────────────────
  cron.schedule('0 10 * * *', async () => {
    console.log('[Cron] Randevu hatırlatmaları gönderiliyor...');
    await sendTomorrowReminders(); // SMS

    // E-posta hatırlatmaları
    try {
      const { query } = require('../db');
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
         WHERE a.starts_at::date=$1
           AND a.status='scheduled'
           AND p.email IS NOT NULL
           AND (a.email_reminder_sent IS NULL OR a.email_reminder_sent=false)`,
        [dateStr]
      );
      let emailSent = 0;
      for (const apt of apts.rows) {
        const result = await sendAppointmentReminderEmail(apt);
        if (result.success) {
          emailSent++;
          await query('UPDATE appointments SET email_reminder_sent=true WHERE id=$1', [apt.id]).catch(()=>{});
        }
      }
      if (emailSent > 0) console.log(`[Cron] ${emailSent} e-posta hatırlatması gönderildi`);
    } catch (err) {
      console.error('[Cron] Email reminder error:', err.message);
    }
  }, { timezone: 'Europe/Istanbul' });

  // ── Trial süresi dolan hesap kontrolü — her gün 09:00'da ─────────────
  cron.schedule('0 9 * * *', async () => {
    try {
      const expired = await query(
        `SELECT id, name FROM tenants
         WHERE plan = 'trial'
           AND plan_status = 'active'
           AND trial_ends_at < NOW() - INTERVAL '1 day'`
      );
      if (expired.rows.length) {
        console.log(`[Cron] ${expired.rows.length} trial süresi dolmuş hesap bulundu`);
        // Mark as expired (soft — still accessible but with warning)
        for (const t of expired.rows) {
          await query(
            `UPDATE tenants SET settings = jsonb_set(settings, '{trial_expired}', 'true'::jsonb)
             WHERE id = $1`,
            [t.id]
          );
        }
      }
    } catch (err) {
      console.error('[Cron] Trial check error:', err.message);
    }
  }, { timezone: 'Europe/Istanbul' });

  // ── Düşük stok bildirimi — her Pazartesi 08:00'da ────────────────────
  cron.schedule('0 8 * * 1', async () => {
    try {
      const low = await query(
        `SELECT i.name, i.stock_qty, i.min_qty, t.id as tenant_id
         FROM inventory_items i
         JOIN tenants t ON t.id = i.tenant_id
         WHERE i.stock_qty <= i.min_qty`
      );
      if (low.rows.length) {
        console.log(`[Cron] ${low.rows.length} düşük stok kalemi`);
        // Group by tenant and insert notifications
        const byTenant = {};
        for (const item of low.rows) {
          if (!byTenant[item.tenant_id]) byTenant[item.tenant_id] = [];
          byTenant[item.tenant_id].push(item.name);
        }
        for (const [tenantId, items] of Object.entries(byTenant)) {
          await query(
            `INSERT INTO notifications (tenant_id, type, title, body, channel, status)
             VALUES ($1, 'low_stock', 'Düşük Stok Uyarısı', $2, 'in_app', 'pending')`,
            [tenantId, `${items.length} ürün kritik stok seviyesinde: ${items.slice(0, 3).join(', ')}${items.length > 3 ? '...' : ''}`]
          );
        }
      }
    } catch (err) {
      console.error('[Cron] Stock check error:', err.message);
    }
  }, { timezone: 'Europe/Istanbul' });

  // ── Bekleyen fatura hatırlatması — her Cuma 11:00'da ─────────────────
  cron.schedule('0 11 * * 5', async () => {
    try {
      const pending = await query(
        `SELECT COUNT(*) as c, SUM(total - amount_paid) as v, tenant_id
         FROM invoices
         WHERE status IN ('draft', 'partial')
           AND inv_date < NOW() - INTERVAL '14 days'
         GROUP BY tenant_id`
      );
      for (const row of pending.rows) {
        if (parseFloat(row.v) > 0) {
          await query(
            `INSERT INTO notifications (tenant_id, type, title, body, channel, status)
             VALUES ($1, 'pending_invoices', 'Bekleyen Faturalar', $2, 'in_app', 'pending')`,
            [row.tenant_id, `${row.c} faturada toplam ₺${parseFloat(row.v).toLocaleString('tr-TR', { minimumFractionDigits: 2 })} ödeme bekliyor.`]
          );
        }
      }
    } catch (err) {
      console.error('[Cron] Invoice check error:', err.message);
    }
  }, { timezone: 'Europe/Istanbul' });
}

module.exports = { startScheduler };
