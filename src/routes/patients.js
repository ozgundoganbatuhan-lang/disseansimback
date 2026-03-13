'use strict';
const router = require('express').Router();
const { authMiddleware, tenantMiddleware, can, auditLog } = require('../middleware/auth');
const { query } = require('../db');

router.use(authMiddleware, tenantMiddleware);

router.get('/', can('patient.read'), async (req, res) => {
  try {
    const { q, page = 1, limit = 50, tag, active } = req.query;
    const offset = (parseInt(page)-1) * parseInt(limit);
    let where = 'WHERE p.tenant_id=$1 AND p.deleted_at IS NULL';
    const params = [req.tenantId];
    let pi = 2;
    if (q) { where += ' AND (p.first_name||$' +pi+ '||p.last_name||$' +(pi+1)+ '||COALESCE(p.phone,$' +(pi+2)+ ')||COALESCE(p.tc,$' +(pi+3)+ ')) ILIKE $' +(pi+4); params.push(' ', ' ', '', '', '%'+q+'%'); pi+=5; }
    if (tag) { where += ' AND $'+pi+'=ANY(p.tags)'; params.push(tag); pi++; }
    if (active !== undefined) { where += ' AND p.is_active=$'+pi; params.push(active==='true'); pi++; }
    const countR = await query('SELECT COUNT(*) FROM patients p '+where, params);
    const rows = await query('SELECT p.id,p.first_name,p.last_name,p.tc,p.birth_date,p.gender,p.phone,p.email,p.blood_type,p.allergies,p.insurance,p.tags,p.is_active,p.created_at FROM patients p '+where+' ORDER BY p.created_at DESC LIMIT $'+pi+' OFFSET $'+(pi+1), [...params, parseInt(limit), offset]);
    res.json({ patients: rows.rows, total: parseInt(countR.rows[0].count), page: parseInt(page), limit: parseInt(limit) });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.post('/', can('patient.write'), async (req, res) => {
  try {
    const f = req.body;
    if (!f.first_name || !f.last_name) return res.status(400).json({ error: 'Ad soyad zorunlu' });
    // Check patient limit
    if (req.membership.max_patients) {
      const cnt = await query('SELECT COUNT(*) FROM patients WHERE tenant_id=$1 AND deleted_at IS NULL', [req.tenantId]);
      if (parseInt(cnt.rows[0].count) >= req.membership.max_patients) return res.status(402).json({ error: 'Hasta limitine ulastiniz. Litfen planınızı yukseltin.' });
    }
    const r = await query(
      'INSERT INTO patients (tenant_id,branch_id,tc,first_name,last_name,birth_date,gender,phone,email,address,blood_type,allergies,systemic_diseases,medications,insurance,insurance_no,emergency_name,emergency_phone,tags,referral_source,notes,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING *',
      [req.tenantId, f.branch_id||null, f.tc||null, f.first_name, f.last_name, f.birth_date||null, f.gender||null, f.phone||null, f.email||null, f.address||null, f.blood_type||null, f.allergies||null, f.systemic_diseases||null, f.medications||null, f.insurance||null, f.insurance_no||null, f.emergency_name||null, f.emergency_phone||null, f.tags||null, f.referral_source||null, f.notes||null, req.user.id]
    );
    await auditLog(req.tenantId, req.user.id, 'patient.create', 'patient', r.rows[0].id, null, r.rows[0], req);
    res.status(201).json(r.rows[0]);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.get('/:id', can('patient.read'), async (req, res) => {
  try {
    const p = await query('SELECT * FROM patients WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL', [req.params.id, req.tenantId]);
    if (!p.rows.length) return res.status(404).json({ error: 'Hasta bulunamadi' });
    const pat = p.rows[0];
    const [teeth, plans, notes, rxs, xrays, apts, invoices] = await Promise.all([
      query('SELECT * FROM teeth_records WHERE patient_id=$1 ORDER BY tooth_no', [pat.id]),
      query('SELECT * FROM treatment_plans WHERE patient_id=$1 AND tenant_id=$2 ORDER BY created_at DESC', [pat.id, req.tenantId]),
      query('SELECT tn.*, u.name as doctor_name FROM treatment_notes tn LEFT JOIN users u ON u.id=tn.doctor_id WHERE tn.patient_id=$1 AND tn.tenant_id=$2 ORDER BY tn.session_date DESC LIMIT 30', [pat.id, req.tenantId]),
      query('SELECT rx.*, u.name as doctor_name FROM prescriptions rx LEFT JOIN users u ON u.id=rx.doctor_id WHERE rx.patient_id=$1 AND rx.tenant_id=$2 ORDER BY rx.rx_date DESC LIMIT 20', [pat.id, req.tenantId]),
      query('SELECT * FROM xrays WHERE patient_id=$1 AND tenant_id=$2 ORDER BY taken_date DESC', [pat.id, req.tenantId]),
      query('SELECT * FROM appointments WHERE patient_id=$1 AND tenant_id=$2 ORDER BY starts_at DESC LIMIT 20', [pat.id, req.tenantId]),
      query('SELECT * FROM invoices WHERE patient_id=$1 AND tenant_id=$2 ORDER BY inv_date DESC LIMIT 20', [pat.id, req.tenantId]),
    ]);
    res.json({ ...pat, teeth: teeth.rows, plans: plans.rows, notes: notes.rows, prescriptions: rxs.rows, xrays: xrays.rows, appointments: apts.rows, invoices: invoices.rows });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.put('/:id', can('patient.write'), async (req, res) => {
  try {
    const p = await query('SELECT * FROM patients WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL', [req.params.id, req.tenantId]);
    if (!p.rows.length) return res.status(404).json({ error: 'Hasta bulunamadi' });
    const old = p.rows[0]; const f = { ...old, ...req.body };
    const r = await query(
      'UPDATE patients SET tc=$1,first_name=$2,last_name=$3,birth_date=$4,gender=$5,phone=$6,email=$7,address=$8,blood_type=$9,allergies=$10,systemic_diseases=$11,medications=$12,insurance=$13,insurance_no=$14,emergency_name=$15,emergency_phone=$16,tags=$17,referral_source=$18,notes=$19,is_active=$20,updated_at=NOW() WHERE id=$21 RETURNING *',
      [f.tc,f.first_name,f.last_name,f.birth_date,f.gender,f.phone,f.email,f.address,f.blood_type,f.allergies,f.systemic_diseases,f.medications,f.insurance,f.insurance_no,f.emergency_name,f.emergency_phone,f.tags,f.referral_source,f.notes,f.is_active!==false,old.id]
    );
    await auditLog(req.tenantId, req.user.id, 'patient.update', 'patient', old.id, old, r.rows[0], req);
    res.json(r.rows[0]);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:id', can('patient.delete'), async (req, res) => {
  try {
    const p = await query('SELECT id FROM patients WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL', [req.params.id, req.tenantId]);
    if (!p.rows.length) return res.status(404).json({ error: 'Hasta bulunamadi' });
    await query('UPDATE patients SET deleted_at=NOW() WHERE id=$1', [req.params.id]);
    await auditLog(req.tenantId, req.user.id, 'patient.delete', 'patient', req.params.id, null, null, req);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.get('/:id/export', can('patient.read'), async (req, res) => {
  const p = await query('SELECT * FROM patients WHERE id=$1 AND tenant_id=$2', [req.params.id, req.tenantId]);
  if (!p.rows.length) return res.status(404).json({ error: 'Hasta bulunamadi' });
  const [teeth, plans, notes, rxs, xrays, apts] = await Promise.all([
    query('SELECT * FROM teeth_records WHERE patient_id=$1', [req.params.id]),
    query('SELECT * FROM treatment_plans WHERE patient_id=$1', [req.params.id]),
    query('SELECT * FROM treatment_notes WHERE patient_id=$1', [req.params.id]),
    query('SELECT * FROM prescriptions WHERE patient_id=$1', [req.params.id]),
    query('SELECT * FROM xrays WHERE patient_id=$1', [req.params.id]),
    query('SELECT * FROM appointments WHERE patient_id=$1', [req.params.id]),
  ]);
  await auditLog(req.tenantId, req.user.id, 'patient.export', 'patient', req.params.id, null, null, req);
  res.json({ patient: p.rows[0], teeth: teeth.rows, treatment_plans: plans.rows, treatment_notes: notes.rows, prescriptions: rxs.rows, xrays: xrays.rows, appointments: apts.rows, exported_at: new Date().toISOString() });
});

router.post('/:id/anonymize', can('patient.delete'), async (req, res) => {
  const p = await query('SELECT id FROM patients WHERE id=$1 AND tenant_id=$2', [req.params.id, req.tenantId]);
  if (!p.rows.length) return res.status(404).json({ error: 'Hasta bulunamadi' });
  await query("UPDATE patients SET tc=NULL,first_name='[SILINDI]',last_name='[SILINDI]',phone=NULL,email=NULL,address=NULL,tc=NULL,emergency_name=NULL,emergency_phone=NULL,updated_at=NOW() WHERE id=$1", [req.params.id]);
  await auditLog(req.tenantId, req.user.id, 'patient.anonymize', 'patient', req.params.id, null, null, req);
  res.json({ ok: true });
});

// Teeth (Odontogram)
router.get('/:id/teeth', can('patient.read'), async (req, res) => {
  const p = await query('SELECT id FROM patients WHERE id=$1 AND tenant_id=$2', [req.params.id, req.tenantId]);
  if (!p.rows.length) return res.status(404).json({ error: 'Hasta bulunamadi' });
  const t = await query('SELECT * FROM teeth_records WHERE patient_id=$1 ORDER BY tooth_no', [req.params.id]);
  res.json(t.rows);
});

router.put('/:id/teeth/:toothNo', can('treatment.write'), async (req, res) => {
  const p = await query('SELECT id FROM patients WHERE id=$1 AND tenant_id=$2', [req.params.id, req.tenantId]);
  if (!p.rows.length) return res.status(404).json({ error: 'Hasta bulunamadi' });
  const { status, surfaces, notes } = req.body;
  const r = await query(
    'INSERT INTO teeth_records (patient_id,tenant_id,tooth_no,status,surfaces,notes,recorded_by,recorded_at) VALUES ($1,$2,$3,$4,$5,$6,$7,NOW()) ON CONFLICT (patient_id,tooth_no) DO UPDATE SET status=$4,surfaces=$5,notes=$6,recorded_by=$7,recorded_at=NOW() RETURNING *',
    [req.params.id, req.tenantId, req.params.toothNo, status||'healthy', surfaces||null, notes||null, req.user.id]
  );
  res.json(r.rows[0]);
});

module.exports = router;
