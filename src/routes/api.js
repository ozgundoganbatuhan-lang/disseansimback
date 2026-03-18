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
    const tomorrow = new Date(Date.now()+86400000).toISOString().slice(0,10);
    const last30 = new Date(Date.now()-30*86400000).toISOString().slice(0,10);
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0,10);
    const prevMs = new Date(new Date().getFullYear(), new Date().getMonth()-1, 1).toISOString().slice(0,10);
    const prevMe = new Date(new Date().getFullYear(), new Date().getMonth(), 0).toISOString().slice(0,10);
    const weekAgo = new Date(Date.now()-6*86400000).toISOString().slice(0,10);

    const [a,b,c,d,e,f,g,h,i,j,k,l,m] = await Promise.all([
      query(`SELECT COUNT(*) c FROM appointments WHERE tenant_id=$1 AND starts_at::date=$2 AND status!='cancelled'`,[tid,today]),
      query(`SELECT COUNT(*) c FROM appointments WHERE tenant_id=$1 AND starts_at::date=$2 AND status='completed'`,[tid,today]),
      query(`SELECT COUNT(*) c FROM patients WHERE tenant_id=$1 AND deleted_at IS NULL`,[tid]),
      query(`SELECT COUNT(*) c FROM patients WHERE tenant_id=$1 AND deleted_at IS NULL AND created_at::date>=$2`,[tid,monthStart]),
      query(`SELECT COALESCE(SUM(p.amount),0) v FROM payments p JOIN invoices i ON i.id=p.invoice_id WHERE i.tenant_id=$1 AND p.paid_at::date>=$2`,[tid,monthStart]),
      query(`SELECT COALESCE(SUM(p.amount),0) v FROM payments p JOIN invoices i ON i.id=p.invoice_id WHERE i.tenant_id=$1 AND p.paid_at::date BETWEEN $2 AND $3`,[tid,prevMs,prevMe]),
      query(`SELECT COALESCE(SUM(total-amount_paid),0) v FROM invoices WHERE tenant_id=$1 AND status IN ('draft','partial')`,[tid]),
      query(`SELECT COUNT(*) c FROM inventory_items WHERE tenant_id=$1 AND stock_qty<=min_qty`,[tid]),
      query(`SELECT name,category,stock_qty qty,min_qty,unit FROM inventory_items WHERE tenant_id=$1 AND stock_qty<=min_qty ORDER BY (min_qty-stock_qty) DESC LIMIT 6`,[tid]),
      query(`SELECT COUNT(*) c FROM appointments WHERE tenant_id=$1 AND starts_at::date=$2 AND status='scheduled'`,[tid,tomorrow]),
      query(`SELECT a.id,a.starts_at,a.ends_at,a.type,a.status,a.tooth_numbers,p.first_name,p.last_name,p.phone,u.name doctor_name FROM appointments a JOIN patients p ON p.id=a.patient_id JOIN users u ON u.id=a.doctor_id WHERE a.tenant_id=$1 AND a.starts_at::date=$2 AND a.status!='cancelled' ORDER BY a.starts_at`,[tid,today]),
      query(`SELECT starts_at::date date,COUNT(*) c FROM appointments WHERE tenant_id=$1 AND starts_at::date BETWEEN $2 AND $3 AND status!='cancelled' GROUP BY 1 ORDER BY 1`,[tid,weekAgo,tomorrow]),
      query(`SELECT COUNT(*) total,SUM(CASE WHEN no_show THEN 1 ELSE 0 END) ns FROM appointments WHERE tenant_id=$1 AND starts_at::date BETWEEN $2 AND $3`,[tid,last30,today]),
    ]);
    const rev=parseFloat(e.rows[0].v), prev=parseFloat(f.rows[0].v);
    const ns=m.rows[0];
    res.json({
      todayApts:+a.rows[0].c, completedToday:+b.rows[0].c, remainingToday:Math.max(0,+a.rows[0].c-+b.rows[0].c),
      totalPatients:+c.rows[0].c, newPatientsThisMonth:+d.rows[0].c,
      monthRevenue:rev, revTrend:prev>0?((rev-prev)/prev*100):null,
      pendingInvoices:parseFloat(g.rows[0].v),
      lowStockItems:+h.rows[0].c, lowStockList:i.rows,
      tomorrowApts:+j.rows[0].c, todaySchedule:k.rows, weekSchedule:l.rows,
      noShowRate:ns.total>0?Math.round(ns.ns/ns.total*100):0,
    });
  } catch(err){res.status(500).json({error:err.message});}
});

// ── APPOINTMENTS ───────────────────────────────────────────────────────────
router.get('/appointments', can('appointment.read'), async (req,res)=>{
  try{
    const{date,from,to,doctor_id,patient_id}=req.query;
    let w='WHERE a.tenant_id=$1',p=[req.tenantId],i=2;
    if(date){w+=` AND a.starts_at::date=$${i}`;p.push(date);i++;}
    else if(from&&to){w+=` AND a.starts_at::date BETWEEN $${i} AND $${i+1}`;p.push(from,to);i+=2;}
    if(doctor_id){w+=` AND a.doctor_id=$${i}`;p.push(doctor_id);i++;}
    if(patient_id){w+=` AND a.patient_id=$${i}`;p.push(patient_id);i++;}
    const r=await query(`SELECT a.*,p.first_name,p.last_name,p.phone,u.name doctor_name FROM appointments a JOIN patients p ON p.id=a.patient_id JOIN users u ON u.id=a.doctor_id ${w} ORDER BY a.starts_at`,p);
    res.json(r.rows);
  }catch(err){res.status(500).json({error:err.message});}
});
router.post('/appointments', can('appointment.write'), async (req,res)=>{
  try{
    const f=req.body;if(!f.patient_id||!f.starts_at)return res.status(400).json({error:'Zorunlu alanlar eksik'});
    const did=f.doctor_id||req.user.id;
    const end=f.ends_at||new Date(new Date(f.starts_at).getTime()+30*60000).toISOString();
    const conflict=await query(`SELECT id FROM appointments WHERE tenant_id=$1 AND doctor_id=$2 AND status!='cancelled' AND starts_at<$3 AND ends_at>$4`,[req.tenantId,did,end,f.starts_at]);
    if(conflict.rows.length)return res.status(409).json({error:'Bu saatte çakışan randevu var'});
    const r=await query(`INSERT INTO appointments(tenant_id,patient_id,doctor_id,starts_at,ends_at,type,status,tooth_numbers,notes,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[req.tenantId,f.patient_id,did,f.starts_at,end,f.type||'Muayene','scheduled',f.tooth_numbers||null,f.notes||null,req.user.id]);
    res.status(201).json(r.rows[0]);
  }catch(err){res.status(500).json({error:err.message});}
});
router.put('/appointments/:id', can('appointment.write'), async (req,res)=>{
  try{
    const a=await query('SELECT * FROM appointments WHERE id=$1 AND tenant_id=$2',[req.params.id,req.tenantId]);
    if(!a.rows.length)return res.status(404).json({error:'Bulunamadı'});
    const f={...a.rows[0],...req.body};
    const r=await query(`UPDATE appointments SET patient_id=$1,doctor_id=$2,starts_at=$3,ends_at=$4,type=$5,status=$6,tooth_numbers=$7,notes=$8,no_show=$9 WHERE id=$10 RETURNING *`,[f.patient_id,f.doctor_id,f.starts_at,f.ends_at,f.type,f.status,f.tooth_numbers,f.notes,f.status==='no-show',a.rows[0].id]);
    res.json(r.rows[0]);
  }catch(err){res.status(500).json({error:err.message});}
});
router.delete('/appointments/:id', can('appointment.delete'), async (req,res)=>{
  await query(`UPDATE appointments SET status='cancelled',cancelled_at=NOW() WHERE id=$1 AND tenant_id=$2`,[req.params.id,req.tenantId]);
  res.json({ok:true});
});

// ── TREATMENT PLANS ────────────────────────────────────────────────────────
router.get('/plans', can('treatment.read'), async (req,res)=>{
  const{patient_id,status}=req.query;
  let w='WHERE tp.tenant_id=$1',p=[req.tenantId],i=2;
  if(patient_id){w+=` AND tp.patient_id=$${i}`;p.push(patient_id);i++;}
  if(status){w+=` AND tp.status=$${i}`;p.push(status);i++;}
  const r=await query(`SELECT tp.*,pt.first_name,pt.last_name FROM treatment_plans tp JOIN patients pt ON pt.id=tp.patient_id ${w} ORDER BY tp.created_at DESC`,p);
  res.json(r.rows);
});
router.post('/plans', can('treatment.write'), async (req,res)=>{
  try{
    const f=req.body;if(!f.patient_id||!f.title)return res.status(400).json({error:'Zorunlu alanlar eksik'});
    const r=await query(`INSERT INTO treatment_plans(tenant_id,patient_id,created_by,title,status,tooth_numbers,diagnosis,icd_code,priority,notes,est_cost,est_sessions) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,[req.tenantId,f.patient_id,req.user.id,f.title,f.status||'planned',f.tooth_numbers||null,f.diagnosis||null,f.icd_code||null,f.priority||'normal',f.notes||null,f.est_cost||null,f.est_sessions||1]);
    res.status(201).json(r.rows[0]);
  }catch(err){res.status(500).json({error:err.message});}
});
router.put('/plans/:id', can('treatment.write'), async (req,res)=>{
  try{
    const a=await query('SELECT * FROM treatment_plans WHERE id=$1 AND tenant_id=$2',[req.params.id,req.tenantId]);
    if(!a.rows.length)return res.status(404).json({error:'Bulunamadı'});
    const f={...a.rows[0],...req.body};
    const r=await query(`UPDATE treatment_plans SET title=$1,status=$2,tooth_numbers=$3,diagnosis=$4,icd_code=$5,priority=$6,notes=$7,est_cost=$8,est_sessions=$9,updated_at=NOW() WHERE id=$10 RETURNING *`,[f.title,f.status,f.tooth_numbers,f.diagnosis,f.icd_code,f.priority,f.notes,f.est_cost,f.est_sessions,a.rows[0].id]);
    res.json(r.rows[0]);
  }catch(err){res.status(500).json({error:err.message});}
});
router.delete('/plans/:id', can('treatment.write'), async (req,res)=>{
  await query('DELETE FROM treatment_plans WHERE id=$1 AND tenant_id=$2',[req.params.id,req.tenantId]);
  res.json({ok:true});
});

// ── NOTES ─────────────────────────────────────────────────────────────────
router.get('/notes', can('treatment.read'), async (req,res)=>{
  const{patient_id,limit}=req.query;
  let w='WHERE tn.tenant_id=$1',p=[req.tenantId],i=2;
  if(patient_id){w+=` AND tn.patient_id=$${i}`;p.push(patient_id);i++;}
  const r=await query(`SELECT tn.*,pt.first_name,pt.last_name,u.name doctor_name FROM treatment_notes tn JOIN patients pt ON pt.id=tn.patient_id JOIN users u ON u.id=tn.doctor_id ${w} ORDER BY tn.session_date DESC,tn.created_at DESC LIMIT ${parseInt(limit)||50}`,p);
  res.json(r.rows);
});
router.post('/notes', can('treatment.write'), async (req,res)=>{
  try{
    const f=req.body;if(!f.patient_id||!f.procedure)return res.status(400).json({error:'Zorunlu alanlar eksik'});
    const r=await query(`INSERT INTO treatment_notes(tenant_id,patient_id,appointment_id,plan_id,doctor_id,tooth_numbers,session_date,procedure,anesthesia,materials,findings,next_steps,duration_mins) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,[req.tenantId,f.patient_id,f.appointment_id||null,f.plan_id||null,f.doctor_id||req.user.id,f.tooth_numbers||null,f.session_date||new Date().toISOString().slice(0,10),f.procedure,f.anesthesia||null,f.materials||null,f.findings||null,f.next_steps||null,f.duration_mins||null]);
    res.status(201).json(r.rows[0]);
  }catch(err){res.status(500).json({error:err.message});}
});
router.delete('/notes/:id', can('treatment.write'), async (req,res)=>{
  await query('DELETE FROM treatment_notes WHERE id=$1 AND tenant_id=$2',[req.params.id,req.tenantId]);
  res.json({ok:true});
});

// ── PRESCRIPTIONS ──────────────────────────────────────────────────────────
router.get('/prescriptions', can('treatment.read'), async (req,res)=>{
  const{patient_id}=req.query;
  let w='WHERE rx.tenant_id=$1',p=[req.tenantId],i=2;
  if(patient_id){w+=` AND rx.patient_id=$${i}`;p.push(patient_id);i++;}
  const r=await query(`SELECT rx.*,pt.first_name,pt.last_name,pt.tc,pt.birth_date,u.name doctor_name,u.title doctor_title FROM prescriptions rx JOIN patients pt ON pt.id=rx.patient_id JOIN users u ON u.id=rx.doctor_id ${w} ORDER BY rx.rx_date DESC LIMIT 100`,p);
  res.json(r.rows);
});
router.get('/prescriptions/:id', can('treatment.read'), async (req,res)=>{
  const r=await query(`SELECT rx.*,pt.first_name,pt.last_name,pt.tc,pt.birth_date,u.name doctor_name,u.title doctor_title FROM prescriptions rx JOIN patients pt ON pt.id=rx.patient_id JOIN users u ON u.id=rx.doctor_id WHERE rx.id=$1 AND rx.tenant_id=$2`,[req.params.id,req.tenantId]);
  if(!r.rows.length)return res.status(404).json({error:'Bulunamadı'});
  res.json(r.rows[0]);
});
router.post('/prescriptions', can('treatment.write'), async (req,res)=>{
  try{
    const f=req.body;if(!f.patient_id)return res.status(400).json({error:'Hasta zorunlu'});
    const drugs=typeof f.drugs==='object'?JSON.stringify(f.drugs):(f.drugs||'[]');
    const r=await query(`INSERT INTO prescriptions(tenant_id,patient_id,doctor_id,appointment_id,rx_date,diagnosis,icd_code,drugs,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[req.tenantId,f.patient_id,f.doctor_id||req.user.id,f.appointment_id||null,f.rx_date||new Date().toISOString().slice(0,10),f.diagnosis||null,f.icd_code||null,drugs,f.notes||null]);
    res.status(201).json(r.rows[0]);
  }catch(err){res.status(500).json({error:err.message});}
});
router.delete('/prescriptions/:id', can('treatment.write'), async (req,res)=>{
  await query('DELETE FROM prescriptions WHERE id=$1 AND tenant_id=$2',[req.params.id,req.tenantId]);
  res.json({ok:true});
});

// ── XRAYS — field bridge: schema(type,taken_date) ↔ frontend(xray_type,taken_at) ─
router.get('/xrays', can('treatment.read'), async (req,res)=>{
  const{patient_id}=req.query;
  let w='WHERE x.tenant_id=$1',p=[req.tenantId],i=2;
  if(patient_id){w+=` AND x.patient_id=$${i}`;p.push(patient_id);i++;}
  const r=await query(`SELECT x.id,x.patient_id,x.doctor_id,x.appointment_id,x.type xray_type,x.taken_date taken_at,x.tooth_numbers,x.findings,x.notes,x.image_data,pt.first_name,pt.last_name FROM xrays x JOIN patients pt ON pt.id=x.patient_id ${w} ORDER BY x.taken_date DESC LIMIT 100`,p);
  res.json(r.rows);
});
router.post('/xrays', can('treatment.write'), async (req,res)=>{
  try{
    const f=req.body;
    if(!f.patient_id)return res.status(400).json({error:'Hasta secilmedi'});
    const pt=await query('SELECT id FROM patients WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL',[f.patient_id,req.tenantId]);
    if(!pt.rows.length)return res.status(404).json({error:'Hasta bu klinige kayitli degil'});
    const xtype=f.xray_type||f.type||'Periapikal';
    const tdate=(f.taken_at||f.taken_date||new Date().toISOString()).slice(0,10);
    let teeth=null;
    if(f.tooth_numbers){
      const raw=Array.isArray(f.tooth_numbers)?f.tooth_numbers:String(f.tooth_numbers).split(/[,\s]+/);
      teeth=raw.map(n=>parseInt(n)).filter(n=>!isNaN(n)&&n>0&&n<=48);
      if(!teeth.length)teeth=null;
    }
    const r=await query(
      `INSERT INTO xrays(tenant_id,patient_id,doctor_id,appointment_id,type,taken_date,tooth_numbers,findings,notes,image_data)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id,type xray_type,taken_date taken_at,tooth_numbers,findings,notes,image_data`,
      [req.tenantId,f.patient_id,f.doctor_id||req.user.id,f.appointment_id||null,xtype,tdate,teeth,f.findings||null,f.notes||null,f.image_data||null]
    );
    res.status(201).json({...r.rows[0],image_data:f.image_data||null});
  }catch(err){
    console.error('Xray save:',err.message);
    if(err.message.includes('value too long'))return res.status(413).json({error:'Goruntu cok buyuk (max 8MB)'});
    res.status(500).json({error:err.message});
  }
});
router.delete('/xrays/:id', can('treatment.write'), async (req,res)=>{
  await query('DELETE FROM xrays WHERE id=$1 AND tenant_id=$2',[req.params.id,req.tenantId]);
  res.json({ok:true});
});

// ── STERILIZATION — field bridge: schema(log_date,device_serial,duration_min,test_result) ↔ frontend(date,serial_no,duration,result) ─
router.get('/sterilization', can('sterilization.write'), async (req,res)=>{
  const{from,to}=req.query;
  let w='WHERE s.tenant_id=$1',p=[req.tenantId],i=2;
  if(from&&to){w+=` AND s.log_date BETWEEN $${i} AND $${i+1}`;p.push(from,to);i+=2;}
  const r=await query(`SELECT s.id,s.log_date date,s.device_name,s.device_serial serial_no,s.cycle_no,s.temperature,s.pressure,s.duration_min duration,s.test_type,s.test_result result,s.notes,u.name operator_name FROM sterilization_logs s LEFT JOIN users u ON u.id=s.operator_id ${w} ORDER BY s.log_date DESC,s.created_at DESC LIMIT 200`,p);
  res.json(r.rows);
});
router.post('/sterilization', can('sterilization.write'), async (req,res)=>{
  try{
    const f=req.body;if(!f.device_name)return res.status(400).json({error:'Cihaz adı zorunlu'});
    const r=await query(`INSERT INTO sterilization_logs(tenant_id,log_date,device_name,device_serial,cycle_no,temperature,pressure,duration_min,test_type,test_result,operator_id,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,[req.tenantId,f.date||new Date().toISOString().slice(0,10),f.device_name,f.serial_no||null,f.cycle_no||null,f.temperature||null,f.pressure||null,f.duration||null,f.test_type||'chemical',f.result||'pass',req.user.id,f.notes||null]);
    res.status(201).json({ok:true,id:r.rows[0].id});
  }catch(err){res.status(500).json({error:err.message});}
});
router.delete('/sterilization/:id', can('sterilization.write'), async (req,res)=>{
  await query('DELETE FROM sterilization_logs WHERE id=$1 AND tenant_id=$2',[req.params.id,req.tenantId]);
  res.json({ok:true});
});

// ── INVOICES ───────────────────────────────────────────────────────────────
router.get('/invoices', can('billing.read'), async (req,res)=>{
  const{patient_id,status}=req.query;
  let w='WHERE i.tenant_id=$1',p=[req.tenantId],i=2;
  if(patient_id){w+=` AND i.patient_id=$${i}`;p.push(patient_id);i++;}
  if(status){w+=` AND i.status=$${i}`;p.push(status);i++;}
  const r=await query(`SELECT i.*,pt.first_name,pt.last_name FROM invoices i JOIN patients pt ON pt.id=i.patient_id ${w} ORDER BY i.inv_date DESC LIMIT 100`,p);
  res.json(r.rows);
});
router.post('/invoices', can('billing.write'), async (req,res)=>{
  try{
    const f=req.body;if(!f.patient_id)return res.status(400).json({error:'Hasta zorunlu'});
    const cnt=await query('SELECT COUNT(*) c FROM invoices WHERE tenant_id=$1',[req.tenantId]);
    const inv_no='DS-'+String(+cnt.rows[0].c+1).padStart(4,'0');
    const items=typeof f.items==='object'?JSON.stringify(f.items):(f.items||'[]');
    const sub=parseFloat(f.subtotal)||0,disc=parseFloat(f.discount||f.discount_amount||0);
    const taxR=parseFloat(f.tax_rate||0),taxA=(sub-disc)*taxR/100;
    const total=Math.max(0,sub-disc+taxA),paid=parseFloat(f.amount_paid||0);
    const status=paid>=total&&total>0?'paid':paid>0?'partial':'draft';
    const r=await query(`INSERT INTO invoices(tenant_id,patient_id,appointment_id,inv_no,inv_date,status,items,subtotal,discount_amount,tax_rate,tax_amount,total,amount_paid,notes,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,[req.tenantId,f.patient_id,f.appointment_id||null,inv_no,f.inv_date||new Date().toISOString().slice(0,10),status,items,sub.toFixed(2),disc.toFixed(2),taxR.toFixed(2),taxA.toFixed(2),total.toFixed(2),paid.toFixed(2),f.notes||null,req.user.id]);
    if(paid>0)await query(`INSERT INTO payments(tenant_id,invoice_id,amount,method,paid_at,recorded_by) VALUES($1,$2,$3,$4,NOW(),$5)`,[req.tenantId,r.rows[0].id,paid,f.payment_method||'nakit',req.user.id]);
    res.status(201).json(r.rows[0]);
  }catch(err){res.status(500).json({error:err.message});}
});
router.put('/invoices/:id', can('billing.write'), async (req,res)=>{
  try{
    const inv=await query('SELECT * FROM invoices WHERE id=$1 AND tenant_id=$2',[req.params.id,req.tenantId]);
    if(!inv.rows.length)return res.status(404).json({error:'Bulunamadı'});
    const f={...inv.rows[0],...req.body};
    const np=parseFloat(f.amount_paid||0),tot=parseFloat(f.total||0);
    const st=np>=tot&&tot>0?'paid':np>0?'partial':'draft';
    const r=await query('UPDATE invoices SET status=$1,amount_paid=$2,notes=$3 WHERE id=$4 RETURNING *',[st,np.toFixed(2),f.notes,inv.rows[0].id]);
    res.json(r.rows[0]);
  }catch(err){res.status(500).json({error:err.message});}
});
router.delete('/invoices/:id', can('billing.manage'), async (req,res)=>{
  await query(`UPDATE invoices SET status='void' WHERE id=$1 AND tenant_id=$2`,[req.params.id,req.tenantId]);
  res.json({ok:true});
});

// ── INVENTORY — field bridge: schema(stock_qty,unit_cost) ↔ frontend(qty,price) ─
router.get('/inventory', can('inventory.read'), async (req,res)=>{
  const r=await query(`SELECT id,name,sku,category,unit,stock_qty qty,min_qty,unit_cost price,expiry_date,notes,(stock_qty<=min_qty) is_low FROM inventory_items WHERE tenant_id=$1 ORDER BY name`,[req.tenantId]);
  res.json(r.rows);
});
router.post('/inventory', can('inventory.write'), async (req,res)=>{
  try{
    const f=req.body;if(!f.name)return res.status(400).json({error:'Ürün adı zorunlu'});
    const r=await query(`INSERT INTO inventory_items(tenant_id,name,sku,category,unit,stock_qty,min_qty,unit_cost,expiry_date,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id,name,sku,category,unit,stock_qty qty,min_qty,unit_cost price,expiry_date`,[req.tenantId,f.name,f.sku||null,f.category||null,f.unit||'adet',parseFloat(f.qty||f.stock_qty||0),parseFloat(f.min_qty||5),parseFloat(f.price||f.unit_cost||0)||null,f.expiry_date||null,f.notes||null]);
    res.status(201).json(r.rows[0]);
  }catch(err){res.status(500).json({error:err.message});}
});
router.put('/inventory/:id', can('inventory.write'), async (req,res)=>{
  try{
    const it=await query('SELECT * FROM inventory_items WHERE id=$1 AND tenant_id=$2',[req.params.id,req.tenantId]);
    if(!it.rows.length)return res.status(404).json({error:'Bulunamadı'});
    const f={...it.rows[0],...req.body};
    const r=await query(`UPDATE inventory_items SET name=$1,sku=$2,category=$3,unit=$4,stock_qty=$5,min_qty=$6,unit_cost=$7,expiry_date=$8,notes=$9,updated_at=NOW() WHERE id=$10 RETURNING id,name,sku,category,unit,stock_qty qty,min_qty,unit_cost price,expiry_date`,[f.name,f.sku,f.category,f.unit,parseFloat(f.qty||f.stock_qty),parseFloat(f.min_qty),parseFloat(f.price||f.unit_cost)||null,f.expiry_date||null,f.notes,it.rows[0].id]);
    res.json(r.rows[0]);
  }catch(err){res.status(500).json({error:err.message});}
});
router.delete('/inventory/:id', can('inventory.write'), async (req,res)=>{
  await query('DELETE FROM inventory_items WHERE id=$1 AND tenant_id=$2',[req.params.id,req.tenantId]);
  res.json({ok:true});
});

// ── ANALYTICS ─────────────────────────────────────────────────────────────
router.get('/analytics', can('reports.view'), async (req,res)=>{
  try{
    const{from,to}=req.query;
    const f=from||new Date(Date.now()-30*86400000).toISOString().slice(0,10);
    const t=to||new Date().toISOString().slice(0,10);
    const tid=req.tenantId;
    const[r1,r2,r3,r4,r5,r6,r7,r8]=await Promise.all([
      query(`SELECT COALESCE(SUM(p.amount),0) v FROM payments p JOIN invoices i ON i.id=p.invoice_id WHERE i.tenant_id=$1 AND p.paid_at::date BETWEEN $2 AND $3`,[tid,f,t]),
      query(`SELECT COUNT(*) c FROM patients WHERE tenant_id=$1 AND created_at::date BETWEEN $2 AND $3 AND deleted_at IS NULL`,[tid,f,t]),
      query(`SELECT COUNT(*) c FROM appointments WHERE tenant_id=$1 AND starts_at::date BETWEEN $2 AND $3 AND status!='cancelled'`,[tid,f,t]),
      query(`SELECT COUNT(*) c FROM appointments WHERE tenant_id=$1 AND starts_at::date BETWEEN $2 AND $3 AND (status='no-show' OR no_show=true)`,[tid,f,t]),
      query(`SELECT paid_at::date date,COALESCE(SUM(amount),0) amount FROM payments p JOIN invoices i ON i.id=p.invoice_id WHERE i.tenant_id=$1 AND p.paid_at::date BETWEEN $2 AND $3 GROUP BY 1 ORDER BY 1`,[tid,f,t]),
      query(`SELECT method,COALESCE(SUM(amount),0) total,COUNT(*) count FROM payments p JOIN invoices i ON i.id=p.invoice_id WHERE i.tenant_id=$1 AND p.paid_at::date BETWEEN $2 AND $3 GROUP BY method ORDER BY total DESC`,[tid,f,t]),
      query(`SELECT type,COUNT(*) count FROM appointments WHERE tenant_id=$1 AND starts_at::date BETWEEN $2 AND $3 AND status!='cancelled' GROUP BY type ORDER BY count DESC LIMIT 10`,[tid,f,t]),
      query(`SELECT pt.first_name,pt.last_name,COALESCE(SUM(py.amount),0) total FROM payments py JOIN invoices i ON i.id=py.invoice_id JOIN patients pt ON pt.id=i.patient_id WHERE i.tenant_id=$1 AND py.paid_at::date BETWEEN $2 AND $3 GROUP BY pt.id,pt.first_name,pt.last_name ORDER BY total DESC LIMIT 10`,[tid,f,t]),
    ]);
    res.json({totalRevenue:parseFloat(r1.rows[0].v),newPatients:+r2.rows[0].c,totalApts:+r3.rows[0].c,noShowCount:+r4.rows[0].c,dailyRevenue:r5.rows,paymentMethods:r6.rows,aptByType:r7.rows,topPatients:r8.rows});
  }catch(err){res.status(500).json({error:err.message});}
});

// ── USER / TENANT UPDATE ───────────────────────────────────────────────────
router.put('/users/:id', async (req,res)=>{
  try{
    const{name,title,specialty,speciality,diploma_no,phone}=req.body;
    const r=await query(`UPDATE users SET name=COALESCE($1,name),title=COALESCE($2,title),speciality=COALESCE($3,speciality),diploma_no=COALESCE($4,diploma_no),phone=COALESCE($5,phone) WHERE id=$6 RETURNING id,email,name,title,speciality,diploma_no,phone`,[name||null,title||null,specialty||speciality||null,diploma_no||null,phone||null,req.user.id]);
    res.json({ok:true,user:r.rows[0]});
  }catch(err){res.status(500).json({error:err.message});}
});
router.put('/tenant', can('settings.manage'), async (req,res)=>{
  try{
    const{name}=req.body;
    const r=await query(`UPDATE tenants SET name=COALESCE($1,name),updated_at=NOW() WHERE id=$2 RETURNING id,name`,[name||null,req.tenantId]);
    res.json({ok:true,tenant:r.rows[0]});
  }catch(err){res.status(500).json({error:err.message});}
});
router.put('/tenant/sms', async (req,res)=>{
  try{
    const{header,auto_reminder}=req.body;
    await query(`UPDATE tenants SET settings=settings||$1::jsonb WHERE id=$2`,[JSON.stringify({sms_header:header,sms_auto_reminder:auto_reminder}),req.tenantId]);
    res.json({ok:true});
  }catch(err){res.status(500).json({error:err.message});}
});

// ── SMS EXTRAS ─────────────────────────────────────────────────────────────
router.get('/sms/stats', async (req,res)=>{
  try{
    const[s,t]=await Promise.all([
      query(`SELECT COUNT(*) c,COUNT(*) FILTER(WHERE status='sent') ok FROM notifications WHERE tenant_id=$1 AND channel='sms' AND created_at>=NOW()-INTERVAL '30 days'`,[req.tenantId]),
      query(`SELECT COUNT(*) c FROM appointments WHERE tenant_id=$1 AND starts_at::date=NOW()::date+1 AND status='scheduled'`,[req.tenantId]),
    ]);
    const total=+s.rows[0].c,succ=+s.rows[0].ok;
    res.json({sent:total,successRate:total>0?Math.round(succ/total*100):0,tomorrow:+t.rows[0].c});
  }catch(err){res.status(500).json({error:err.message});}
});
router.post('/sms/manual', can('appointment.write'), async (req,res)=>{
  try{
    const{patient_id,message}=req.body;
    if(!patient_id||!message)return res.status(400).json({error:'Hasta ve mesaj zorunlu'});
    const pt=await query('SELECT phone FROM patients WHERE id=$1 AND tenant_id=$2',[patient_id,req.tenantId]);
    if(!pt.rows.length)return res.status(404).json({error:'Hasta bulunamadı'});
    let success=false;
    try{const svc=require('../services/sms');const r=await svc.sendSMS(pt.rows[0].phone,message);success=r.success;}catch(e){}
    await query(`INSERT INTO notifications(tenant_id,patient_id,type,title,body,channel,status,sent_at) VALUES($1,$2,'manual_sms','Manuel SMS',$3,'sms',$4,NOW())`,[req.tenantId,patient_id,message,success?'sent':'failed']);
    res.json({success,message:success?'SMS gönderildi':'Gönderildi (NetGSM konfigüre edilmemiş — mock)'});
  }catch(err){res.status(500).json({error:err.message});}
});

// ── SCHEDULER ─────────────────────────────────────────────────────────────
router.post('/scheduler/run', can('settings.manage'), async (req,res)=>{
  try{const sch=require('../services/scheduler');if(sch.runReminders)await sch.runReminders(req.tenantId);res.json({ok:true});}
  catch(err){res.json({ok:true,note:err.message});}
});

// ── TEAM ───────────────────────────────────────────────────────────────────
router.get('/team', can('team.manage'), async (req,res)=>{
  const r=await query(`SELECT m.id,m.role,m.status,m.joined_at,u.id user_id,u.email,u.name,u.title,u.last_seen_at FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 ORDER BY m.created_at`,[req.tenantId]);
  res.json({members:r.rows});
});
router.post('/team/invite', can('team.manage'), async (req,res)=>{
  try{
    const{email,role}=req.body;if(!email||!role)return res.status(400).json({error:'Email ve rol zorunlu'});
    const ex=await query('SELECT id FROM users WHERE email=$1',[email.toLowerCase()]);
    let uid=ex.rows[0]?.id;
    if(!uid){const h=await require('bcryptjs').hash(require('crypto').randomBytes(8).toString('hex'),10);const u=await query(`INSERT INTO users(email,password_hash,name,email_verified) VALUES($1,$2,$3,false) RETURNING id`,[email.toLowerCase(),h,email.split('@')[0]]);uid=u.rows[0].id;}
    const mem=await query('SELECT id FROM memberships WHERE user_id=$1 AND tenant_id=$2',[uid,req.tenantId]);
    if(mem.rows.length)return res.status(409).json({error:'Bu kullanıcı zaten ekipte'});
    await query(`INSERT INTO memberships(user_id,tenant_id,role,status,invited_by) VALUES($1,$2,$3,'active',$4)`,[uid,req.tenantId,role,req.user.id]);
    res.json({ok:true});
  }catch(err){res.status(500).json({error:err.message});}
});
router.delete('/team/:id', can('team.manage'), async (req,res)=>{
  const m=await query('SELECT user_id FROM memberships WHERE id=$1 AND tenant_id=$2',[req.params.id,req.tenantId]);
  if(!m.rows.length)return res.status(404).json({error:'Üye bulunamadı'});
  if(m.rows[0].user_id===req.user.id)return res.status(400).json({error:'Kendinizi çıkaramazsınız'});
  await query('DELETE FROM memberships WHERE id=$1',[req.params.id]);
  res.json({ok:true});
});

// ── SETTINGS ───────────────────────────────────────────────────────────────
router.get('/settings', async (req,res)=>{
  const[ten,usr,br]=await Promise.all([
    query('SELECT id,name,slug,plan,plan_status,trial_ends_at,max_users,max_patients,settings FROM tenants WHERE id=$1',[req.tenantId]),
    query('SELECT id,email,name,title,speciality,diploma_no,phone FROM users WHERE id=$1',[req.user.id]),
    query('SELECT * FROM branches WHERE tenant_id=$1 ORDER BY is_main DESC,name',[req.tenantId]),
  ]);
  res.json({tenant:ten.rows[0],user:usr.rows[0],branches:br.rows});
});

module.exports = router;
