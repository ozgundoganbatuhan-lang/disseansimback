'use strict';
// Klinik modülleri (2026-10): personel/koltuk listesi, dijital onam, laboratuvar, taksit/tahsilat, hekim primi
const crypto = require('crypto');
const router = require('express').Router();
const { authMiddleware, tenantMiddleware, can } = require('../middleware/auth');
const { query, withTransaction } = require('../db');
const { validPng } = require('./publicConsent');
const { TEMPLATES } = require('../services/consentTemplates');
router.use(authMiddleware, tenantMiddleware);

const trDay = (offsetMs = 0) => new Date(Date.now() + offsetMs + 3 * 3600000).toISOString().slice(0, 10);
const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const ok = (fn) => async (req, res) => { try { await fn(req, res); } catch (e) { console.error(e); res.status(500).json({ error: 'İşlem yapılamadı' }); } };
async function ownPatient(tid, id) { return (await query('SELECT id, first_name, last_name, phone, tc FROM patients WHERE id=$1 AND tenant_id=$2', [id, tid])).rows[0]; }

// ── Personel & koltuk (takvim için; yönetici yetkisi gerektirmez) ─────────
router.get('/staff', can('appointment.read'), ok(async (req, res) => {
  const r = await query(`SELECT u.id, u.name, u.title, m.role, m.commission_pct FROM memberships m JOIN users u ON u.id=m.user_id
    WHERE m.tenant_id=$1 AND m.status<>'removed' ORDER BY (m.role IN ('owner','dentist')) DESC, u.name`, [req.tenantId]);
  res.json(r.rows.map((x) => ({ ...x, commission_pct: ['owner', 'admin'].includes(req.membership.role) ? x.commission_pct : undefined })));
}));
router.get('/chairs', can('appointment.read'), ok(async (req, res) => {
  res.json((await query('SELECT id, name, color FROM chairs WHERE tenant_id=$1 AND is_active ORDER BY name', [req.tenantId])).rows);
}));
router.post('/chairs', can('team.manage'), ok(async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 40);
  if (!name) return res.status(400).json({ error: 'Koltuk adı gerekli' });
  const color = /^#[0-9a-f]{6}$/i.test(req.body.color || '') ? req.body.color : '#0f766e';
  res.status(201).json((await query('INSERT INTO chairs(tenant_id,name,color,is_active) VALUES($1,$2,$3,true) RETURNING id,name,color', [req.tenantId, name, color])).rows[0]);
}));
router.delete('/chairs/:id', can('team.manage'), ok(async (req, res) => {
  await query('UPDATE chairs SET is_active=false WHERE id=$1 AND tenant_id=$2', [req.params.id, req.tenantId]);
  res.json({ ok: true });
}));
router.put('/staff/:userId/commission', can('team.manage'), ok(async (req, res) => {
  const pct = Number(req.body.commission_pct);
  if (!(pct >= 0 && pct <= 100)) return res.status(400).json({ error: 'Prim oranı 0-100 arası olmalı' });
  await query('UPDATE memberships SET commission_pct=$1 WHERE user_id=$2 AND tenant_id=$3', [pct, req.params.userId, req.tenantId]);
  res.json({ ok: true });
}));

// ── Dijital onam ────────────────────────────────────────────────────────
router.get('/consent-templates', can('patient.read'), (req, res) => res.json(TEMPLATES.map(({ key, title, body }) => ({ key, title, body }))));
router.get('/consents', can('treatment.read'), ok(async (req, res) => {
  const p = [req.tenantId]; let w = 'WHERE c.tenant_id=$1';
  if (req.query.patient_id) { p.push(req.query.patient_id); w += ' AND c.patient_id=$2'; }
  res.json((await query(`SELECT c.id, c.patient_id, c.template_key, c.title, c.signed_at, c.signer_name, c.created_at, c.token_expires,
    (c.signed_at IS NULL AND c.token IS NOT NULL AND c.token_expires > NOW()) AS pending, pt.first_name, pt.last_name
    FROM consent_forms c JOIN patients pt ON pt.id=c.patient_id ${w} ORDER BY c.created_at DESC LIMIT 200`, p)).rows);
}));
router.get('/consents/:id', can('treatment.read'), ok(async (req, res) => {
  const r = (await query(`SELECT c.*, pt.first_name, pt.last_name, t.name tenant_name FROM consent_forms c JOIN patients pt ON pt.id=c.patient_id
    JOIN tenants t ON t.id=c.tenant_id WHERE c.id=$1 AND c.tenant_id=$2`, [req.params.id, req.tenantId])).rows[0];
  if (!r) return res.status(404).json({ error: 'Bulunamadı' });
  delete r.token; res.json(r);
}));
/** Onam oluştur: imza klinikte (tablet) atılacaksa signature gönderilir; yoksa 72 saatlik imza linki üretilir. */
router.post('/consents', can('patient.write'), ok(async (req, res) => {
  const f = req.body;
  const pt = await ownPatient(req.tenantId, f.patient_id);
  if (!pt) return res.status(400).json({ error: 'Hasta bulunamadı' });
  const tpl = TEMPLATES.find((t) => t.key === f.template_key);
  const title = String(f.title || tpl?.title || '').trim().slice(0, 160);
  const body = String(f.body || tpl?.body || '').trim().slice(0, 20000);
  if (!title || !body) return res.status(400).json({ error: 'Onam metni gerekli' });
  const sig = validPng(f.signature) ? f.signature : null;
  if (f.signature && !sig) return res.status(400).json({ error: 'İmza alınamadı' });
  if (sig) {
    const name = String(f.signer_name || `${pt.first_name} ${pt.last_name}`).slice(0, 120);
    const r = await query(`INSERT INTO consent_forms(tenant_id,patient_id,template_key,title,body,signed_at,signer_name,signature,signed_ip,signed_ua,created_by)
      VALUES($1,$2,$3,$4,$5,NOW(),$6,$7,$8,$9,$10) RETURNING id, signed_at`, [req.tenantId, pt.id, f.template_key || 'ozel', title, body, name, sig, req.ip, String(req.headers['user-agent'] || '').slice(0, 200), req.user.id]);
    return res.status(201).json(r.rows[0]);
  }
  const token = crypto.randomBytes(24).toString('base64url');
  const r = await query(`INSERT INTO consent_forms(tenant_id,patient_id,template_key,title,body,token,token_expires,created_by)
    VALUES($1,$2,$3,$4,$5,$6,NOW() + interval '72 hours',$7) RETURNING id`, [req.tenantId, pt.id, f.template_key || 'ozel', title, body, token, req.user.id]);
  res.status(201).json({ id: r.rows[0].id, token, phone: pt.phone });
}));

// ── Laboratuvar ─────────────────────────────────────────────────────────
const LAB_ST = ['sent', 'tryin', 'received', 'delivered', 'cancelled'];
router.get('/labs', can('treatment.read'), ok(async (req, res) => {
  const p = [req.tenantId]; let w = 'WHERE l.tenant_id=$1';
  if (req.query.open === '1') w += " AND l.status IN ('sent','tryin','received')";
  if (req.query.patient_id) { p.push(req.query.patient_id); w += ` AND l.patient_id=$${p.length}`; }
  res.json((await query(`SELECT l.*, pt.first_name, pt.last_name, pt.phone, u.name doctor_name,
    (l.due_on - (NOW() AT TIME ZONE 'Europe/Istanbul')::date) days_left
    FROM lab_orders l JOIN patients pt ON pt.id=l.patient_id LEFT JOIN users u ON u.id=l.doctor_id ${w}
    ORDER BY (l.status IN ('delivered','cancelled')), l.due_on NULLS LAST, l.created_at DESC LIMIT 300`, p)).rows);
}));
router.post('/labs', can('treatment.write'), ok(async (req, res) => {
  const f = req.body;
  if (!(await ownPatient(req.tenantId, f.patient_id))) return res.status(400).json({ error: 'Hasta bulunamadı' });
  const lab = String(f.lab_name || '').trim().slice(0, 120), work = String(f.work_type || '').trim().slice(0, 120);
  if (!lab || !work) return res.status(400).json({ error: 'Laboratuvar ve iş türü gerekli' });
  const r = await query(`INSERT INTO lab_orders(tenant_id,patient_id,doctor_id,lab_name,work_type,teeth,shade,sent_on,due_on,cost,notes,created_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [req.tenantId, f.patient_id, req.user.id, lab, work, String(f.teeth || '').slice(0, 80) || null, String(f.shade || '').slice(0, 20) || null,
      isDate(f.sent_on) ? f.sent_on : trDay(), isDate(f.due_on) ? f.due_on : null, Math.max(0, Number(f.cost) || 0), String(f.notes || '').slice(0, 1000) || null, req.user.id]);
  res.status(201).json(r.rows[0]);
}));
router.put('/labs/:id', can('treatment.write'), ok(async (req, res) => {
  const st = req.body.status;
  if (!LAB_ST.includes(st)) return res.status(400).json({ error: 'Geçersiz durum' });
  const r = await query(`UPDATE lab_orders SET status=$1, received_on = CASE WHEN $1 IN ('received','delivered') THEN COALESCE(received_on, (NOW() AT TIME ZONE 'Europe/Istanbul')::date) ELSE received_on END
    WHERE id=$2 AND tenant_id=$3 RETURNING *`, [st, req.params.id, req.tenantId]);
  if (!r.rows.length) return res.status(404).json({ error: 'Bulunamadı' });
  res.json(r.rows[0]);
}));

// ── Tahsilat & taksit ───────────────────────────────────────────────────
router.get('/installments', can('billing.read'), ok(async (req, res) => {
  const p = [req.tenantId]; let w = 'WHERE s.tenant_id=$1 AND s.paid_at IS NULL AND i.status<>\'void\'';
  if (req.query.invoice_id) { p.push(req.query.invoice_id); w = `WHERE s.tenant_id=$1 AND s.invoice_id=$2`; }
  else if (req.query.days) { p.push(trDay(Number(req.query.days) * 86400000)); w += ` AND s.due_on <= $${p.length}`; }
  res.json((await query(`SELECT s.*, i.inv_no, i.patient_id, pt.first_name, pt.last_name, pt.phone,
    (s.due_on - (NOW() AT TIME ZONE 'Europe/Istanbul')::date) days_left
    FROM installments s JOIN invoices i ON i.id=s.invoice_id JOIN patients pt ON pt.id=i.patient_id ${w} ORDER BY s.due_on, s.no LIMIT 300`, p)).rows);
}));
/** Faturaya ödeme al: payments kaydı + fatura bakiyesi + en eski açık taksitler kapanır */
router.post('/invoices/:id/pay', can('billing.write'), ok(async (req, res) => {
  const amt = Math.round(Number(req.body.amount) * 100) / 100;
  if (!(amt > 0) || !Number.isFinite(amt)) return res.status(400).json({ error: 'Tutar sıfırdan büyük olmalı' });
  const method = ['nakit', 'kredi', 'havale', 'sigorta', 'cek'].includes(req.body.method) ? req.body.method : 'nakit';
  const out = await withTransaction(async (c) => {
    const inv = (await c.query('SELECT * FROM invoices WHERE id=$1 AND tenant_id=$2 FOR UPDATE', [req.params.id, req.tenantId])).rows[0];
    if (!inv || inv.status === 'void') return { code: 404, error: 'Fatura bulunamadı' };
    const remaining = Math.round((Number(inv.total) - Number(inv.amount_paid)) * 100) / 100;
    if (amt > remaining + 0.01) return { code: 400, error: `Kalan bakiye ${remaining.toFixed(2)} TL` };
    const pay = (await c.query('INSERT INTO payments(tenant_id,invoice_id,amount,method,paid_at,recorded_by,notes) VALUES($1,$2,$3,$4,NOW(),$5,$6) RETURNING id',
      [req.tenantId, inv.id, amt, method, req.user.id, String(req.body.notes || '').slice(0, 300) || null])).rows[0];
    const paid = Math.round((Number(inv.amount_paid) + amt) * 100) / 100;
    const st = paid >= Number(inv.total) - 0.01 ? 'paid' : 'partial';
    await c.query('UPDATE invoices SET amount_paid=$1, status=$2 WHERE id=$3 AND tenant_id=$4', [paid.toFixed(2), st, inv.id, req.tenantId]);
    let left = amt;
    for (const s2 of (await c.query('SELECT id, amount FROM installments WHERE invoice_id=$1 AND paid_at IS NULL ORDER BY no FOR UPDATE', [inv.id])).rows) {
      if (left + 0.01 < Number(s2.amount)) break;
      await c.query('UPDATE installments SET paid_at=NOW(), payment_id=$1 WHERE id=$2', [pay.id, s2.id]);
      left -= Number(s2.amount);
    }
    return { ok: true, status: st, amount_paid: paid };
  });
  if (out.code) return res.status(out.code).json({ error: out.error });
  res.json(out);
}));

// ── Hekim primi (hakediş) ───────────────────────────────────────────────
router.get('/commission', can('reports.view'), ok(async (req, res) => {
  const from = isDate(req.query.from) ? req.query.from : trDay().slice(0, 8) + '01', to = isDate(req.query.to) ? req.query.to : trDay();
  const r = await query(`
    WITH pay AS (
      SELECT COALESCE(i.doctor_id, a.doctor_id, i.created_by) doctor_id, p.amount
      FROM payments p JOIN invoices i ON i.id=p.invoice_id LEFT JOIN appointments a ON a.id=i.appointment_id AND a.tenant_id=i.tenant_id
      WHERE i.tenant_id=$1 AND i.status<>'void' AND (p.paid_at AT TIME ZONE 'Europe/Istanbul')::date BETWEEN $2 AND $3),
    lab AS (SELECT doctor_id, SUM(cost) cost FROM lab_orders WHERE tenant_id=$1 AND status<>'cancelled' AND sent_on BETWEEN $2 AND $3 GROUP BY doctor_id)
    SELECT u.id, u.name, m.commission_pct, COALESCE(SUM(pay.amount),0)::float collected, COALESCE(MAX(lab.cost),0)::float lab_cost
    FROM memberships m JOIN users u ON u.id=m.user_id LEFT JOIN pay ON pay.doctor_id=u.id LEFT JOIN lab ON lab.doctor_id=u.id
    WHERE m.tenant_id=$1 AND m.status<>'removed' GROUP BY u.id, u.name, m.commission_pct ORDER BY collected DESC`, [req.tenantId, from, to]);
  const deductLab = req.query.lab !== '0';
  res.json({ from, to, deductLab, rows: r.rows.map((x) => {
    const base = Math.max(0, x.collected - (deductLab ? x.lab_cost : 0));
    return { ...x, base, commission: Math.round(base * Number(x.commission_pct)) / 100 };
  }) });
}));

// ── e-Nabız / MBYS için dışa aktarım (entegrasyon tamamlanana kadar elle giriş kolaylığı) ──
router.get('/export/visits.csv', can('treatment.read'), ok(async (req, res) => {
  if (!['owner', 'admin', 'dentist'].includes(req.membership.role)) return res.status(403).json({ error: 'Bu dışa aktarım için hekim ya da yönetici yetkisi gerekir' });
  const from = isDate(req.query.from) ? req.query.from : trDay(-30 * 86400000), to = isDate(req.query.to) ? req.query.to : trDay();
  const r = await query(`SELECT to_char(a.starts_at AT TIME ZONE 'Europe/Istanbul','YYYY-MM-DD HH24:MI') ts, pt.tc, pt.first_name, pt.last_name, pt.birth_date, pt.gender, pt.phone,
      a.type, a.tooth_numbers, u.name doctor,
      (SELECT string_agg(COALESCE(n.procedure,'') || ' ' || COALESCE(n.findings,''), ' | ') FROM treatment_notes n WHERE n.appointment_id=a.id) notes
    FROM appointments a JOIN patients pt ON pt.id=a.patient_id JOIN users u ON u.id=a.doctor_id
    WHERE a.tenant_id=$1 AND a.status='completed' AND (a.starts_at AT TIME ZONE 'Europe/Istanbul')::date BETWEEN $2 AND $3 ORDER BY a.starts_at LIMIT 5000`, [req.tenantId, from, to]).catch(async () =>
    query(`SELECT to_char(a.starts_at AT TIME ZONE 'Europe/Istanbul','YYYY-MM-DD HH24:MI') ts, pt.tc, pt.first_name, pt.last_name, pt.birth_date, pt.gender, pt.phone, a.type, a.tooth_numbers, u.name doctor, a.notes
      FROM appointments a JOIN patients pt ON pt.id=a.patient_id JOIN users u ON u.id=a.doctor_id
      WHERE a.tenant_id=$1 AND a.status='completed' AND (a.starts_at AT TIME ZONE 'Europe/Istanbul')::date BETWEEN $2 AND $3 ORDER BY a.starts_at`, [req.tenantId, from, to]));
  const esc = (v) => { const t = v == null ? '' : String(v instanceof Date ? v.toISOString().slice(0, 16).replace('T', ' ') : v).replace(/\s+/g, ' ').trim(); return /[";\n]/.test(t) || /^[=@|]/.test(t) || (/^[+\-]/.test(t) && !/^\+?[\d\s()-]+$/.test(t)) ? '"' + t.replace(/"/g, '""').replace(/^([=+\-@|])/, "'$1") + '"' : t; };
  const head = ['Tarih', 'TC Kimlik No', 'Ad', 'Soyad', 'Doğum tarihi', 'Cinsiyet', 'Telefon', 'İşlem', 'Diş no', 'Hekim', 'Tanı / tedavi notu'];
  const lines = r.rows.map((x) => [x.ts, x.tc, x.first_name, x.last_name, x.birth_date ? String(x.birth_date instanceof Date ? x.birth_date.toISOString() : x.birth_date).slice(0, 10) : '', x.gender, x.phone, x.type, x.tooth_numbers, x.doctor, x.notes].map(esc).join(';'));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="muayeneler-${from}-${to}.csv"`);
  res.send('﻿' + [head.join(';'), ...lines].join('\r\n'));
}));

module.exports = router;
