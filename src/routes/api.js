'use strict';
const router = require('express').Router();
const { authMiddleware, tenantMiddleware, can } = require('../middleware/auth');
const { query } = require('../db');

router.use(authMiddleware, tenantMiddleware);

// ── DASHBOARD ──────────────────────────────────────────────────────────────
router.get('/dashboard', async (req, res) => {
  try {
    const tid = req.tenantId;
    const today = new Date().toISOString().slice(0,10);
    const month = today.slice(0,7);
    const [todayApts, totalPatients, monthRevenue, activePlans, pendingInvoices, lowStock, recentApts] = await Promise.all([
      query('SELECT COUNT(*) as c FROM appointments WHERE tenant_id=$1 AND starts_at::date=$2 AND status!=\'cancelled\'', [tid, today]),
      query('SELECT COUNT(*) as c FROM patients WHERE tenant_id=$1 AND deleted_at IS NULL', [tid]),
      query("SELECT COALESCE(SUM(amount),0) as v FROM payments WHERE tenant_id=$1 AND paid_at::text LIKE $2", [tid, month+'%']),
      query("SELECT COUNT(*) as c FROM treatment_plans WHERE tenant_id=$1 AND status='planned'", [tid]),
      query("SELECT COALESCE(SUM(total-amount_paid),0) as v FROM invoices WHERE tenant_id=$1 AND status!='paid'", [tid]),
      query("SELECT COUNT(*) as c FROM inventory_items WHERE tenant_id=$1 AND stock_qty<=min_qty", [tid]),
      query('SELECT a.id, a.starts_at, a.ends_at, a.type, a.status, a.tooth_numbers, p.first_name, p.last_name, p.phone FROM appointments a JOIN patients p ON p.id=a.patient_id WHERE a.tenant_id=$1 AND a.starts_at::date=$2 AND a.status!=\'cancelled\' ORDER BY a.starts_at', [tid, today]),
    ]);
    const tenant = await query('SELECT plan, plan_status, trial_ends_at, next_billing_date FROM tenants WHERE id=$1', [tid]);
    res.json({
      todayApts: parseInt(todayApts.rows[0].c),
      totalPatients: parseInt(totalPatients.rows[0].c),
      monthRevenue: parseFloat(monthRevenue.rows[0].v),
      activePlans: parseInt(activePlans.rows[0].c),
      pendingInvoices: parseFloat(pendingInvoices.rows[0].v),
      lowStockItems: parseInt(lowStock.rows[0].c),
      todaySchedule: recentApts.rows,
      subscription: tenant.rows[0],
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── APPOINTMENTS ───────────────────────────────────────────────────────────
router.get('/appointments', can('appointment.read'), async (req, res) => {
  try {
    const { date, from, to, doctor_id, patient_id } = req.query;
    let where = 'WHERE a.tenant_id=$1'; const params = [req.tenantId]; let pi = 2;
    if (date) { where += ' AND a.starts_at::date=$'+pi; params.push(date); pi++; }
    else if (from && to) { where += ' AND a.starts_at::date BETWEEN $'+pi+' AND $'+(pi+1); params.push(from,to); pi+=2; }
    if (doctor_id) { where += ' AND a.doctor_id=$'+pi; params.push(doctor_id); pi++; }
    if (patient_id) { where += ' AND a.patient_id=$'+pi; params.push(patient_id); pi++; }
    const r = await query('SELECT a.*, p.first_name, p.last_name, p.phone, u.name as doctor_name FROM appointments a JOIN patients p ON p.id=a.patient_id JOIN users u ON u.id=a.doctor_id '+where+' ORDER BY a.starts_at', params);
    res.json(r.rows);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.post('/appointments', can('appointment.write'), async (req, res) => {
  try {
    const f = req.body;
    if (!f.patient_id || !f.doctor_id || !f.starts_at || !f.ends_at) return res.status(400).json({ error: 'Zorunlu alanlar eksik' });
    // Conflict check
    const conflict = await query('SELECT id FROM appointments WHERE tenant_id=$1 AND doctor_id=$2 AND status!=\'cancelled\' AND (starts_at < $3 AND ends_at > $4)', [req.tenantId, f.doctor_id, f.ends_at, f.starts_at]);
    if (conflict.rows.length) return res.status(409).json({ error: 'Hekim bu saatte baska randevusu var', conflictId: conflict.rows[0].id });
    const r = await query('INSERT INTO appointments (tenant_id,branch_id,patient_id,doctor_id,chair_id,starts_at,ends_at,type,status,tooth_numbers,notes,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *', [req.tenantId, f.branch_id||null, f.patient_id, f.doctor_id, f.chair_id||null, f.starts_at, f.ends_at, f.type||'Muayene', 'scheduled', f.tooth_numbers||null, f.notes||null, req.user.id]);
    res.status(201).json(r.rows[0]);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.put('/appointments/:id', can('appointment.write'), async (req, res) => {
  try {
    const a = await query('SELECT * FROM appointments WHERE id=$1 AND tenant_id=$2', [req.params.id, req.tenantId]);
    if (!a.rows.length) return res.status(404).json({ error: 'Randevu bulunamadi' });
    const f = { ...a.rows[0], ...req.body };
    const r = await query('UPDATE appointments SET patient_id=$1,doctor_id=$2,chair_id=$3,starts_at=$4,ends_at=$5,type=$6,status=$7,tooth_numbers=$8,notes=$9 WHERE id=$10 RETURNING *', [f.patient_id,f.doctor_id,f.chair_id,f.starts_at,f.ends_at,f.type,f.status,f.tooth_numbers,f.notes,a.rows[0].id]);
    res.json(r.rows[0]);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.delete('/appointments/:id', can('appointment.delete'), async (req, res) => {
  await query('UPDATE appointments SET status=$1, cancelled_at=NOW() WHERE id=$2 AND tenant_id=$3', ['cancelled', req.params.id, req.tenantId]);
  res.json({ ok: true });
});

// ── TREATMENT PLANS ────────────────────────────────────────────────────────
router.get('/plans', can('treatment.read'), async (req, res) => {
  const { patient_id, status } = req.query;
  let where = 'WHERE tp.tenant_id=$1'; const params = [req.tenantId]; let pi = 2;
  if (patient_id) { where += ' AND tp.patient_id=$'+pi; params.push(patient_id); pi++; }
  if (status) { where += ' AND tp.status=$'+pi; params.push(status); pi++; }
  const r = await query('SELECT tp.*, p.first_name, p.last_name FROM treatment_plans tp JOIN patients p ON p.id=tp.patient_id '+where+' ORDER BY tp.created_at DESC', params);
  res.json(r.rows);
});

router.post('/plans', can('treatment.write'), async (req, res) => {
  try {
    const f = req.body;
    if (!f.patient_id || !f.title) return res.status(400).json({ error: 'Zorunlu alanlar eksik' });
    const r = await query('INSERT INTO treatment_plans (tenant_id,patient_id,created_by,title,status,tooth_numbers,diagnosis,icd_code,priority,notes,est_cost,est_sessions) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *', [req.tenantId,f.patient_id,req.user.id,f.title,f.status||'planned',f.tooth_numbers||null,f.diagnosis||null,f.icd_code||null,f.priority||'normal',f.notes||null,f.est_cost||null,f.est_sessions||1]);
    res.status(201).json(r.rows[0]);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.put('/plans/:id', can('treatment.write'), async (req, res) => {
  try {
    const a = await query('SELECT * FROM treatment_plans WHERE id=$1 AND tenant_id=$2', [req.params.id, req.tenantId]);
    if (!a.rows.length) return res.status(404).json({ error: 'Plan bulunamadi' });
    const f = { ...a.rows[0], ...req.body };
    const r = await query("UPDATE treatment_plans SET title=$1,status=$2,tooth_numbers=$3,diagnosis=$4,icd_code=$5,priority=$6,notes=$7,est_cost=$8,est_sessions=$9,updated_at=NOW() WHERE id=$10 RETURNING *", [f.title,f.status,f.tooth_numbers,f.diagnosis,f.icd_code,f.priority,f.notes,f.est_cost,f.est_sessions,a.rows[0].id]);
    res.json(r.rows[0]);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.delete('/plans/:id', can('treatment.write'), async (req, res) => {
  await query('DELETE FROM treatment_plans WHERE id=$1 AND tenant_id=$2', [req.params.id, req.tenantId]);
  res.json({ ok: true });
});

// ── TREATMENT NOTES ────────────────────────────────────────────────────────
router.get('/notes', can('treatment.read'), async (req, res) => {
  const { patient_id } = req.query;
  let where = 'WHERE tn.tenant_id=$1'; const params = [req.tenantId]; let pi = 2;
  if (patient_id) { where += ' AND tn.patient_id=$'+pi; params.push(patient_id); pi++; }
  const r = await query('SELECT tn.*, p.first_name, p.last_name, u.name as doctor_name FROM treatment_notes tn JOIN patients p ON p.id=tn.patient_id JOIN users u ON u.id=tn.doctor_id '+where+' ORDER BY tn.session_date DESC, tn.created_at DESC LIMIT 100', params);
  res.json(r.rows);
});

router.post('/notes', can('treatment.write'), async (req, res) => {
  try {
    const f = req.body;
    if (!f.patient_id || !f.procedure) return res.status(400).json({ error: 'Zorunlu alanlar eksik' });
    const r = await query('INSERT INTO treatment_notes (tenant_id,patient_id,appointment_id,plan_id,doctor_id,tooth_numbers,session_date,procedure,anesthesia,materials,findings,next_steps,duration_mins) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *', [req.tenantId,f.patient_id,f.appointment_id||null,f.plan_id||null,f.doctor_id||req.user.id,f.tooth_numbers||null,f.session_date||new Date().toISOString().slice(0,10),f.procedure,f.anesthesia||null,f.materials||null,f.findings||null,f.next_steps||null,f.duration_mins||null]);
    res.status(201).json(r.rows[0]);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.delete('/notes/:id', can('treatment.write'), async (req, res) => {
  await query('DELETE FROM treatment_notes WHERE id=$1 AND tenant_id=$2', [req.params.id, req.tenantId]);
  res.json({ ok: true });
});

// ── PRESCRIPTIONS ──────────────────────────────────────────────────────────
router.get('/prescriptions', can('treatment.read'), async (req, res) => {
  const { patient_id } = req.query;
  let where = 'WHERE rx.tenant_id=$1'; const params = [req.tenantId]; let pi = 2;
  if (patient_id) { where += ' AND rx.patient_id=$'+pi; params.push(patient_id); pi++; }
  const r = await query('SELECT rx.*, p.first_name, p.last_name, p.tc, p.birth_date, u.name as doctor_name FROM prescriptions rx JOIN patients p ON p.id=rx.patient_id JOIN users u ON u.id=rx.doctor_id '+where+' ORDER BY rx.rx_date DESC LIMIT 100', params);
  res.json(r.rows);
});

router.post('/prescriptions', can('treatment.write'), async (req, res) => {
  try {
    const f = req.body;
    if (!f.patient_id || !f.drugs) return res.status(400).json({ error: 'Zorunlu alanlar eksik' });
    const drugs = typeof f.drugs === 'object' ? JSON.stringify(f.drugs) : f.drugs;
    const r = await query('INSERT INTO prescriptions (tenant_id,patient_id,doctor_id,appointment_id,rx_date,diagnosis,icd_code,drugs,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *', [req.tenantId,f.patient_id,f.doctor_id||req.user.id,f.appointment_id||null,f.rx_date||new Date().toISOString().slice(0,10),f.diagnosis||null,f.icd_code||null,drugs,f.notes||null]);
    res.status(201).json(r.rows[0]);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.delete('/prescriptions/:id', can('treatment.write'), async (req, res) => {
  await query('DELETE FROM prescriptions WHERE id=$1 AND tenant_id=$2', [req.params.id, req.tenantId]);
  res.json({ ok: true });
});

// ── X-RAYS ─────────────────────────────────────────────────────────────────
router.get('/xrays', can('treatment.read'), async (req, res) => {
  const { patient_id } = req.query;
  let where = 'WHERE x.tenant_id=$1'; const params = [req.tenantId]; let pi = 2;
  if (patient_id) { where += ' AND x.patient_id=$'+pi; params.push(patient_id); pi++; }
  const r = await query('SELECT x.*, p.first_name, p.last_name FROM xrays x JOIN patients p ON p.id=x.patient_id '+where+' ORDER BY x.taken_date DESC', params);
  res.json(r.rows);
});

router.post('/xrays', can('treatment.write'), async (req, res) => {
  try {
    const f = req.body;
    if (!f.patient_id || !f.type) return res.status(400).json({ error: 'Zorunlu alanlar eksik' });
    const r = await query('INSERT INTO xrays (tenant_id,patient_id,doctor_id,appointment_id,taken_date,type,tooth_numbers,file_url,findings,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *', [req.tenantId,f.patient_id,f.doctor_id||req.user.id,f.appointment_id||null,f.taken_date||new Date().toISOString().slice(0,10),f.type,f.tooth_numbers||null,f.file_url||null,f.findings||null,f.notes||null]);
    res.status(201).json(r.rows[0]);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.delete('/xrays/:id', can('treatment.write'), async (req, res) => {
  await query('DELETE FROM xrays WHERE id=$1 AND tenant_id=$2', [req.params.id, req.tenantId]);
  res.json({ ok: true });
});

// ── STERILIZATION ──────────────────────────────────────────────────────────
router.get('/sterilization', can('sterilization.write'), async (req, res) => {
  const { from, to } = req.query;
  let where = 'WHERE s.tenant_id=$1'; const params = [req.tenantId]; let pi = 2;
  if (from && to) { where += ' AND s.log_date BETWEEN $'+pi+' AND $'+(pi+1); params.push(from, to); pi+=2; }
  const r = await query('SELECT s.*, u.name as operator_name FROM sterilization_logs s LEFT JOIN users u ON u.id=s.operator_id '+where+' ORDER BY s.log_date DESC, s.created_at DESC LIMIT 200', params);
  res.json(r.rows);
});

router.post('/sterilization', can('sterilization.write'), async (req, res) => {
  try {
    const f = req.body;
    if (!f.device_name) return res.status(400).json({ error: 'Cihaz adi zorunlu' });
    const r = await query('INSERT INTO sterilization_logs (tenant_id,branch_id,log_date,device_name,device_serial,cycle_no,temperature,pressure,duration_min,test_type,test_result,operator_id,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *', [req.tenantId,f.branch_id||null,f.log_date||new Date().toISOString().slice(0,10),f.device_name,f.device_serial||null,f.cycle_no||null,f.temperature||null,f.pressure||null,f.duration_min||null,f.test_type||'chemical',f.test_result||'pass',f.operator_id||req.user.id,f.notes||null]);
    res.status(201).json(r.rows[0]);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.delete('/sterilization/:id', can('sterilization.write'), async (req, res) => {
  await query('DELETE FROM sterilization_logs WHERE id=$1 AND tenant_id=$2', [req.params.id, req.tenantId]);
  res.json({ ok: true });
});

// ── INVOICES ───────────────────────────────────────────────────────────────
router.get('/invoices', can('billing.read'), async (req, res) => {
  const { patient_id, status } = req.query;
  let where = 'WHERE i.tenant_id=$1'; const params = [req.tenantId]; let pi = 2;
  if (patient_id) { where += ' AND i.patient_id=$'+pi; params.push(patient_id); pi++; }
  if (status) { where += ' AND i.status=$'+pi; params.push(status); pi++; }
  const r = await query('SELECT i.*, p.first_name, p.last_name FROM invoices i JOIN patients p ON p.id=i.patient_id '+where+' ORDER BY i.inv_date DESC LIMIT 100', params);
  res.json(r.rows);
});

router.post('/invoices', can('billing.write'), async (req, res) => {
  try {
    const f = req.body;
    if (!f.patient_id || !f.items) return res.status(400).json({ error: 'Zorunlu alanlar eksik' });
    const cnt = await query('SELECT COUNT(*) as c FROM invoices WHERE tenant_id=$1', [req.tenantId]);
    const inv_no = 'DS-' + String(parseInt(cnt.rows[0].c)+1).padStart(4,'0');
    const items = typeof f.items === 'object' ? JSON.stringify(f.items) : f.items;
    const sub = parseFloat(f.subtotal)||0, disc = parseFloat(f.discount_amount)||0;
    const taxRate = parseFloat(f.tax_rate)||0;
    const taxAmt = ((sub-disc)*taxRate/100);
    const total = (sub - disc + taxAmt);
    const paid = parseFloat(f.amount_paid)||0;
    const status = paid >= total ? 'paid' : paid > 0 ? 'partial' : 'draft';
    const r = await query('INSERT INTO invoices (tenant_id,branch_id,patient_id,appointment_id,inv_no,inv_date,due_date,status,items,subtotal,discount_amount,tax_rate,tax_amount,total,amount_paid,notes,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *', [req.tenantId,f.branch_id||null,f.patient_id,f.appointment_id||null,inv_no,f.inv_date||new Date().toISOString().slice(0,10),f.due_date||null,status,items,sub.toFixed(2),disc.toFixed(2),taxRate.toFixed(2),taxAmt.toFixed(2),total.toFixed(2),paid.toFixed(2),f.notes||null,req.user.id]);
    if (paid > 0) {
      await query('INSERT INTO payments (tenant_id,invoice_id,amount,method,paid_at,recorded_by) VALUES ($1,$2,$3,$4,NOW(),$5)', [req.tenantId, r.rows[0].id, paid, f.payment_method||'nakit', req.user.id]);
    }
    res.status(201).json(r.rows[0]);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.put('/invoices/:id', can('billing.write'), async (req, res) => {
  try {
    const inv = await query('SELECT * FROM invoices WHERE id=$1 AND tenant_id=$2', [req.params.id, req.tenantId]);
    if (!inv.rows.length) return res.status(404).json({ error: 'Fatura bulunamadi' });
    const f = { ...inv.rows[0], ...req.body };
    const newPaid = parseFloat(f.amount_paid)||0;
    const total = parseFloat(f.total)||0;
    const status = newPaid >= total ? 'paid' : newPaid > 0 ? 'partial' : 'draft';
    const r = await query('UPDATE invoices SET status=$1,amount_paid=$2,notes=$3,due_date=$4 WHERE id=$5 RETURNING *', [status, newPaid.toFixed(2), f.notes, f.due_date||null, inv.rows[0].id]);
    res.json(r.rows[0]);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.delete('/invoices/:id', can('billing.manage'), async (req, res) => {
  await query('UPDATE invoices SET status=$1 WHERE id=$2 AND tenant_id=$3', ['void', req.params.id, req.tenantId]);
  res.json({ ok: true });
});

// ── INVENTORY ──────────────────────────────────────────────────────────────
router.get('/inventory', can('inventory.read'), async (req, res) => {
  const r = await query('SELECT i.*, s.name as supplier_name FROM inventory_items i LEFT JOIN suppliers s ON s.id=i.supplier_id WHERE i.tenant_id=$1 ORDER BY i.name', [req.tenantId]);
  res.json(r.rows);
});

router.post('/inventory', can('inventory.write'), async (req, res) => {
  try {
    const f = req.body;
    if (!f.name) return res.status(400).json({ error: 'Urun adi zorunlu' });
    const r = await query('INSERT INTO inventory_items (tenant_id,branch_id,supplier_id,name,sku,category,unit,stock_qty,min_qty,unit_cost,expiry_date,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *', [req.tenantId,f.branch_id||null,f.supplier_id||null,f.name,f.sku||null,f.category||null,f.unit||'adet',f.stock_qty||0,f.min_qty||5,f.unit_cost||null,f.expiry_date||null,f.notes||null]);
    res.status(201).json(r.rows[0]);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.put('/inventory/:id', can('inventory.write'), async (req, res) => {
  try {
    const item = await query('SELECT * FROM inventory_items WHERE id=$1 AND tenant_id=$2', [req.params.id, req.tenantId]);
    if (!item.rows.length) return res.status(404).json({ error: 'Urun bulunamadi' });
    const f = { ...item.rows[0], ...req.body };
    const r = await query('UPDATE inventory_items SET name=$1,sku=$2,category=$3,unit=$4,stock_qty=$5,min_qty=$6,unit_cost=$7,supplier_id=$8,expiry_date=$9,notes=$10,updated_at=NOW() WHERE id=$11 RETURNING *', [f.name,f.sku,f.category,f.unit,f.stock_qty,f.min_qty,f.unit_cost,f.supplier_id,f.expiry_date,f.notes,item.rows[0].id]);
    res.json(r.rows[0]);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.delete('/inventory/:id', can('inventory.write'), async (req, res) => {
  await query('DELETE FROM inventory_items WHERE id=$1 AND tenant_id=$2', [req.params.id, req.tenantId]);
  res.json({ ok: true });
});

// ── TEAM ───────────────────────────────────────────────────────────────────
router.get('/team', can('team.manage'), async (req, res) => {
  const r = await query('SELECT m.id, m.role, m.status, m.joined_at, u.id as user_id, u.email, u.name, u.title, u.speciality, u.last_seen_at FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 ORDER BY m.created_at', [req.tenantId]);
  res.json(r.rows);
});

router.put('/team/:membershipId', can('team.manage'), async (req, res) => {
  const { role, status } = req.body;
  const r = await query('UPDATE memberships SET role=COALESCE($1,role), status=COALESCE($2,status) WHERE id=$3 AND tenant_id=$4 RETURNING *', [role, status, req.params.membershipId, req.tenantId]);
  if (!r.rows.length) return res.status(404).json({ error: 'Uye bulunamadi' });
  res.json(r.rows[0]);
});

// ── SETTINGS ───────────────────────────────────────────────────────────────
router.get('/settings', async (req, res) => {
  const tenant = await query('SELECT id, name, slug, plan, plan_status, trial_ends_at, next_billing_date, max_users, max_patients, ai_tokens_monthly, storage_gb, settings FROM tenants WHERE id=$1', [req.tenantId]);
  const user = await query('SELECT id, email, name, title, speciality, diploma_no, phone FROM users WHERE id=$1', [req.user.id]);
  const branches = await query('SELECT * FROM branches WHERE tenant_id=$1 ORDER BY is_main DESC, name', [req.tenantId]);
  res.json({ tenant: tenant.rows[0], user: user.rows[0], branches: branches.rows });
});

router.put('/settings/user', async (req, res) => {
  const { name, title, speciality, diploma_no, phone } = req.body;
  const r = await query('UPDATE users SET name=COALESCE($1,name), title=COALESCE($2,title), speciality=COALESCE($3,speciality), diploma_no=COALESCE($4,diploma_no), phone=COALESCE($5,phone) WHERE id=$6 RETURNING id,email,name,title,speciality,diploma_no,phone', [name, title, speciality, diploma_no, phone, req.user.id]);
  res.json(r.rows[0]);
});

router.put('/settings/tenant', can('settings.manage'), async (req, res) => {
  const { name, settings } = req.body;
  const r = await query('UPDATE tenants SET name=COALESCE($1,name), settings=COALESCE($2::jsonb,settings), updated_at=NOW() WHERE id=$3 RETURNING *', [name, settings ? JSON.stringify(settings) : null, req.tenantId]);
  res.json(r.rows[0]);
});

// ── REPORTS ────────────────────────────────────────────────────────────────
router.get('/reports/revenue', can('reports.view'), async (req, res) => {
  const { from, to } = req.query;
  const f = from || new Date(Date.now() - 30*24*60*60*1000).toISOString().slice(0,10);
  const t = to || new Date().toISOString().slice(0,10);
  const [daily, methods, topPatients] = await Promise.all([
    query("SELECT paid_at::date as day, SUM(amount) as total FROM payments WHERE tenant_id=$1 AND paid_at::date BETWEEN $2 AND $3 GROUP BY day ORDER BY day", [req.tenantId, f, t]),
    query("SELECT method, SUM(amount) as total, COUNT(*) as cnt FROM payments WHERE tenant_id=$1 AND paid_at::date BETWEEN $2 AND $3 GROUP BY method ORDER BY total DESC", [req.tenantId, f, t]),
    query("SELECT p.first_name, p.last_name, SUM(py.amount) as total FROM payments py JOIN invoices i ON i.id=py.invoice_id JOIN patients p ON p.id=i.patient_id WHERE py.tenant_id=$1 AND py.paid_at::date BETWEEN $2 AND $3 GROUP BY p.id, p.first_name, p.last_name ORDER BY total DESC LIMIT 10", [req.tenantId, f, t]),
  ]);
  res.json({ daily: daily.rows, byMethod: methods.rows, topPatients: topPatients.rows, from: f, to: t });
});

router.get('/reports/appointments', can('reports.view'), async (req, res) => {
  const { from, to } = req.query;
  const f = from || new Date(Date.now() - 30*24*60*60*1000).toISOString().slice(0,10);
  const t = to || new Date().toISOString().slice(0,10);
  const [byStatus, byType, byDoctor] = await Promise.all([
    query("SELECT status, COUNT(*) as cnt FROM appointments WHERE tenant_id=$1 AND starts_at::date BETWEEN $2 AND $3 GROUP BY status", [req.tenantId, f, t]),
    query("SELECT type, COUNT(*) as cnt FROM appointments WHERE tenant_id=$1 AND starts_at::date BETWEEN $2 AND $3 GROUP BY type ORDER BY cnt DESC", [req.tenantId, f, t]),
    query("SELECT u.name, COUNT(*) as cnt FROM appointments a JOIN users u ON u.id=a.doctor_id WHERE a.tenant_id=$1 AND a.starts_at::date BETWEEN $2 AND $3 GROUP BY u.id, u.name ORDER BY cnt DESC", [req.tenantId, f, t]),
  ]);
  res.json({ byStatus: byStatus.rows, byType: byType.rows, byDoctor: byDoctor.rows });
});

module.exports = router;
