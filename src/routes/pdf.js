'use strict';
const router = require('express').Router();
const { authMiddleware, tenantMiddleware, can } = require('../middleware/auth');
const { query } = require('../db');

router.use(authMiddleware, tenantMiddleware);

// ── Generate treatment plan HTML (printable as PDF) ─────────────────────
router.get('/treatment-plan/:planId', can('treatment.read'), async (req, res) => {
  try {
    const plan = await query(
      `SELECT tp.*, p.first_name, p.last_name, p.birth_date, p.tc, p.phone, p.insurance,
              u.name as doctor_name, u.title as doctor_title, u.speciality, u.diploma_no,
              t.name as clinic_name, t.settings as clinic_settings
       FROM treatment_plans tp
       JOIN patients p ON p.id = tp.patient_id
       JOIN users u ON u.id = tp.created_by
       JOIN tenants t ON t.id = tp.tenant_id
       WHERE tp.id = $1 AND tp.tenant_id = $2`,
      [req.params.planId, req.tenantId]
    );

    if (!plan.rows.length) return res.status(404).json({ error: 'Plan bulunamadı' });
    const d = plan.rows[0];

    const age = d.birth_date
      ? Math.floor((Date.now() - new Date(d.birth_date)) / (365.25 * 24 * 3600 * 1000))
      : null;

    const statusLabel = { planned: 'Planlandı', approved: 'Onaylandı', in_progress: 'Devam Ediyor', completed: 'Tamamlandı' };
    const priorityLabel = { high: 'Yüksek', normal: 'Normal', low: 'Düşük' };

    const settings = d.clinic_settings || {};
    const clinicPhone = settings.phone || '';
    const clinicAddress = settings.address || '';

    const html = `<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8">
<title>Tedavi Planı — ${d.first_name} ${d.last_name}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Manrope:wght@400;600;700&display=swap');
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Manrope', system-ui, sans-serif; color: #1a1a1a; background: #fff; font-size: 13px; line-height: 1.6; }
  .page { max-width: 800px; margin: 0 auto; padding: 40px; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; padding-bottom: 20px; border-bottom: 2px solid #0E1C1F; margin-bottom: 24px; }
  .logo { font-size: 22px; font-weight: 700; color: #0E1C1F; display: flex; align-items: center; gap: 8px; }
  .logo-sub { font-size: 11px; font-weight: 400; color: #666; margin-top: 2px; }
  .clinic-info { text-align: right; font-size: 11px; color: #555; }
  .title-block { text-align: center; margin-bottom: 28px; }
  .doc-title { font-size: 18px; font-weight: 700; color: #0E1C1F; letter-spacing: -0.01em; }
  .doc-no { font-size: 11px; color: #888; margin-top: 4px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 20px; }
  .box { border: 1px solid #e0e0e0; border-radius: 8px; padding: 14px; }
  .box h3 { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #888; margin-bottom: 10px; }
  .row { display: flex; justify-content: space-between; padding: 4px 0; border-bottom: 1px solid #f0f0f0; }
  .row:last-child { border-bottom: none; }
  .row-l { color: #888; font-size: 11px; }
  .row-v { font-weight: 600; font-size: 12px; color: #1a1a1a; }
  .desc-box { border: 1px solid #e0e0e0; border-radius: 8px; padding: 16px; margin-bottom: 20px; }
  .desc-box h3 { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #888; margin-bottom: 10px; }
  .desc-text { font-size: 13px; color: #333; line-height: 1.8; white-space: pre-wrap; }
  .status-badge { display: inline-block; padding: 3px 10px; border-radius: 99px; font-size: 11px; font-weight: 700; }
  .status-planned { background: #e8f4ff; color: #1a6bb5; }
  .status-approved { background: #e8f9ee; color: #1a7a3c; }
  .status-in_progress { background: #fff8e8; color: #b57a1a; }
  .status-completed { background: #e8f9ee; color: #1a7a3c; }
  .cost-block { background: #f8f9fa; border-radius: 8px; padding: 14px; margin-bottom: 20px; display: flex; justify-content: space-between; align-items: center; }
  .cost-label { font-size: 12px; color: #555; }
  .cost-val { font-size: 24px; font-weight: 700; color: #0E1C1F; }
  .approval-block { border: 2px dashed #ccc; border-radius: 8px; padding: 20px; margin-top: 28px; }
  .approval-block h3 { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #888; margin-bottom: 16px; }
  .sig-row { display: flex; gap: 32px; }
  .sig-col { flex: 1; }
  .sig-line { border-bottom: 1px solid #999; margin-bottom: 6px; height: 36px; }
  .sig-label { font-size: 10px; color: #888; }
  .footer { margin-top: 32px; padding-top: 16px; border-top: 1px solid #e0e0e0; display: flex; justify-content: space-between; font-size: 10px; color: #aaa; }
  ${d.patient_ok_at ? '.approved-stamp { position: absolute; top: 50px; right: 40px; border: 3px solid #27a349; border-radius: 8px; padding: 8px 16px; color: #27a349; font-weight: 700; font-size: 14px; transform: rotate(-5deg); opacity: .7; }' : ''}
  @media print { body { print-color-adjust: exact; -webkit-print-color-adjust: exact; } .page { padding: 20px; } }
</style>
</head>
<body>
<div class="page">
  ${d.patient_ok_at ? `<div class="approved-stamp">✓ ONAYLANDI<br><span style="font-size:10px;font-weight:400">${new Date(d.patient_ok_at).toLocaleDateString('tr-TR')}</span></div>` : ''}
  <div class="header">
    <div>
      <div class="logo">🦷 ${d.clinic_name || 'DişSeansım'}</div>
      <div class="logo-sub">Diş Kliniği Yönetim Sistemi</div>
    </div>
    <div class="clinic-info">
      ${clinicPhone ? `<div>📞 ${clinicPhone}</div>` : ''}
      ${clinicAddress ? `<div>📍 ${clinicAddress}</div>` : ''}
      <div>${new Date().toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' })}</div>
    </div>
  </div>

  <div class="title-block">
    <div class="doc-title">TEDAVİ PLANI</div>
    <div class="doc-no">Plan No: ${d.id.slice(0, 8).toUpperCase()} &nbsp;·&nbsp; <span class="status-badge status-${d.status}">${statusLabel[d.status] || d.status}</span></div>
  </div>

  <div class="grid">
    <div class="box">
      <h3>Hasta Bilgileri</h3>
      <div class="row"><span class="row-l">Ad Soyad</span><span class="row-v">${d.first_name} ${d.last_name}</span></div>
      ${d.tc ? `<div class="row"><span class="row-l">TC</span><span class="row-v">${d.tc}</span></div>` : ''}
      ${age ? `<div class="row"><span class="row-l">Yaş</span><span class="row-v">${age} yaş</span></div>` : ''}
      ${d.phone ? `<div class="row"><span class="row-l">Telefon</span><span class="row-v">${d.phone}</span></div>` : ''}
      ${d.insurance ? `<div class="row"><span class="row-l">Sigorta</span><span class="row-v">${d.insurance}</span></div>` : ''}
    </div>
    <div class="box">
      <h3>Hekim & Plan Bilgileri</h3>
      <div class="row"><span class="row-l">Hekim</span><span class="row-v">${d.doctor_title || 'Dr.'} ${d.doctor_name}</span></div>
      ${d.speciality ? `<div class="row"><span class="row-l">Uzmanlık</span><span class="row-v">${d.speciality}</span></div>` : ''}
      ${d.diploma_no ? `<div class="row"><span class="row-l">Diploma No</span><span class="row-v">${d.diploma_no}</span></div>` : ''}
      <div class="row"><span class="row-l">Oluşturma</span><span class="row-v">${new Date(d.created_at).toLocaleDateString('tr-TR')}</span></div>
      <div class="row"><span class="row-l">Öncelik</span><span class="row-v">${priorityLabel[d.priority] || d.priority}</span></div>
    </div>
  </div>

  <div class="desc-box">
    <h3>Plan Başlığı</h3>
    <div style="font-size:15px;font-weight:700;color:#0E1C1F;margin-bottom:8px">${d.title}</div>
    ${d.diagnosis ? `<div style="font-size:12px;color:#555;margin-bottom:10px"><strong>Teşhis:</strong> ${d.diagnosis}</div>` : ''}
    ${d.description ? `<div class="desc-text">${d.description}</div>` : ''}
  </div>

  ${d.est_cost ? `
  <div class="cost-block">
    <div><div class="cost-label">Tahmini Tedavi Maliyeti</div><div style="font-size:11px;color:#888;margin-top:2px">KDV dahil, sigorta hariç</div></div>
    <div class="cost-val">₺${parseFloat(d.est_cost).toLocaleString('tr-TR', { minimumFractionDigits: 2 })}</div>
  </div>` : ''}

  <div class="approval-block">
    <h3>Onay & İmza</h3>
    <p style="font-size:12px;color:#555;margin-bottom:16px;line-height:1.7">Yukarıda belirtilen tedavi planını okudum, anladım ve kabul ediyorum. Tedavi sürecinde doğabilecek riskler hakkında bilgilendirildim.</p>
    <div class="sig-row">
      <div class="sig-col">
        <div class="sig-line"></div>
        <div class="sig-label">Hasta İmzası</div>
        <div style="font-size:11px;color:#888;margin-top:4px">${d.first_name} ${d.last_name}</div>
      </div>
      <div class="sig-col">
        <div class="sig-line"></div>
        <div class="sig-label">Tarih</div>
      </div>
      <div class="sig-col">
        <div class="sig-line"></div>
        <div class="sig-label">Hekim İmzası</div>
        <div style="font-size:11px;color:#888;margin-top:4px">${d.doctor_title || 'Dr.'} ${d.doctor_name}</div>
      </div>
    </div>
  </div>

  <div class="footer">
    <div>Bu belge ${d.clinic_name || 'DişSeansım'} tarafından oluşturulmuştur.</div>
    <div>DişSeansım · disseansim.com</div>
  </div>
</div>
<script>
  // Auto-print when opened directly
  if (window.location.hash === '#print') { window.addEventListener('load', () => window.print()); }
</script>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `inline; filename="tedavi-plani-${d.first_name}-${d.last_name}.html"`);
    res.send(html);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Invoice HTML (printable) ────────────────────────────────────────────
router.get('/invoice/:invoiceId', can('billing.read'), async (req, res) => {
  try {
    const inv = await query(
      `SELECT i.*, p.first_name, p.last_name, p.tc, p.phone, p.address,
              t.name as clinic_name, t.settings as clinic_settings,
              u.name as created_by_name, u.title as created_by_title
       FROM invoices i
       JOIN patients p ON p.id = i.patient_id
       JOIN tenants t ON t.id = i.tenant_id
       JOIN users u ON u.id = i.created_by
       WHERE i.id = $1 AND i.tenant_id = $2`,
      [req.params.invoiceId, req.tenantId]
    );
    if (!inv.rows.length) return res.status(404).json({ error: 'Fatura bulunamadı' });
    const d = inv.rows[0];
    const settings = d.clinic_settings || {};
    const items = d.items || [];
    const total = parseFloat(d.total || 0);
    const paid = parseFloat(d.amount_paid || 0);
    const due = Math.max(0, total - paid);

    const html = `<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8">
<title>Fatura ${d.inv_no}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, sans-serif; color: #1a1a1a; background: #fff; font-size: 13px; }
  .page { max-width: 700px; margin: 0 auto; padding: 40px; }
  .header { display: flex; justify-content: space-between; margin-bottom: 32px; }
  .logo { font-size: 20px; font-weight: 700; color: #0E1C1F; }
  .inv-number { text-align: right; }
  .inv-number .n { font-size: 18px; font-weight: 700; color: #2ECAD8; }
  table { width: 100%; border-collapse: collapse; margin: 20px 0; }
  th { background: #f8f9fa; padding: 10px 12px; text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: #888; }
  td { padding: 10px 12px; border-bottom: 1px solid #f0f0f0; }
  .totals { margin-top: 16px; display: flex; justify-content: flex-end; }
  .totals-box { width: 240px; }
  .t-row { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #f0f0f0; font-size: 13px; }
  .t-row.total { font-weight: 700; font-size: 16px; border-bottom: 2px solid #0E1C1F; }
  .t-row.due { font-weight: 700; color: ${due > 0 ? '#E05252' : '#27a349'}; }
  @media print { body { print-color-adjust: exact; } }
</style>
</head>
<body>
<div class="page">
  <div class="header">
    <div>
      <div class="logo">🦷 ${d.clinic_name}</div>
      ${settings.address ? `<div style="font-size:11px;color:#888;margin-top:4px">${settings.address}</div>` : ''}
      ${settings.phone ? `<div style="font-size:11px;color:#888">${settings.phone}</div>` : ''}
    </div>
    <div class="inv-number">
      <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.08em">Fatura No</div>
      <div class="n">${d.inv_no}</div>
      <div style="font-size:11px;color:#888;margin-top:4px">${new Date(d.inv_date).toLocaleDateString('tr-TR', { day:'numeric', month:'long', year:'numeric' })}</div>
    </div>
  </div>
  <div style="background:#f8f9fa;border-radius:8px;padding:14px;margin-bottom:24px">
    <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Hasta</div>
    <div style="font-weight:700;font-size:15px">${d.first_name} ${d.last_name}</div>
    ${d.tc ? `<div style="font-size:11px;color:#888">TC: ${d.tc}</div>` : ''}
    ${d.phone ? `<div style="font-size:11px;color:#888">${d.phone}</div>` : ''}
  </div>
  <table>
    <thead><tr><th>Açıklama</th><th style="text-align:right">Tutar</th></tr></thead>
    <tbody>
      ${items.length ? items.map(it => `<tr><td>${it.desc || it.description || '—'}</td><td style="text-align:right">₺${parseFloat(it.amount || 0).toLocaleString('tr-TR', { minimumFractionDigits:2 })}</td></tr>`).join('') : `<tr><td colspan="2" style="color:#888">Genel hizmet</td></tr>`}
    </tbody>
  </table>
  <div class="totals">
    <div class="totals-box">
      ${d.discount_amount && parseFloat(d.discount_amount) > 0 ? `<div class="t-row"><span>İndirim</span><span>-₺${parseFloat(d.discount_amount).toLocaleString('tr-TR',{minimumFractionDigits:2})}</span></div>` : ''}
      ${d.tax_rate && parseFloat(d.tax_rate) > 0 ? `<div class="t-row"><span>KDV (%${d.tax_rate})</span><span>₺${(total * parseFloat(d.tax_rate) / (100 + parseFloat(d.tax_rate))).toLocaleString('tr-TR',{minimumFractionDigits:2})}</span></div>` : ''}
      <div class="t-row total"><span>Toplam</span><span>₺${total.toLocaleString('tr-TR', { minimumFractionDigits:2 })}</span></div>
      <div class="t-row"><span>Ödenen</span><span>₺${paid.toLocaleString('tr-TR', { minimumFractionDigits:2 })}</span></div>
      <div class="t-row due"><span>${due > 0 ? 'Kalan' : '✓ Ödendi'}</span><span>${due > 0 ? '₺'+due.toLocaleString('tr-TR',{minimumFractionDigits:2}) : ''}</span></div>
    </div>
  </div>
  <div style="margin-top:32px;padding-top:16px;border-top:1px solid #eee;font-size:10px;color:#aaa;display:flex;justify-content:space-between">
    <div>Düzenleyen: ${d.created_by_title || 'Dr.'} ${d.created_by_name}</div>
    <div>DişSeansım · disseansim.com</div>
  </div>
</div>
</body>
</html>`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
