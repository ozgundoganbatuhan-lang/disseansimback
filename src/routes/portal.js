'use strict';
const router = require('express').Router();
const { query } = require('../db');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

// ── Generate portal token ──────────────────────────────────────────────
// Called from authenticated app, generates a time-limited portal token
const { authMiddleware, tenantMiddleware } = require('../middleware/auth');

router.post('/token', authMiddleware, tenantMiddleware, async (req, res) => {
  try {
    const { patient_id } = req.body;
    if (!patient_id) return res.status(400).json({ error: 'patient_id gerekli' });

    // Verify patient belongs to tenant
    const p = await query(
      'SELECT id, first_name, last_name FROM patients WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL',
      [patient_id, req.tenantId]
    );
    if (!p.rows.length) return res.status(404).json({ error: 'Hasta bulunamadı' });

    const token = jwt.sign(
      { type: 'portal', patientId: patient_id, tenantId: req.tenantId },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    const url = (process.env.FRONTEND_URL || 'https://disseansim.com') + '/hasta.html?t=' + token;
    res.json({ token, url, patient: p.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Verify portal token (public) ─────────────────────────────────────────
function verifyPortalToken(req, res, next) {
  const token = req.query.t || req.headers['x-portal-token'];
  if (!token) return res.status(401).json({ error: 'Portal token gerekli' });
  try {
    const claims = jwt.verify(token, process.env.JWT_SECRET);
    if (claims.type !== 'portal') return res.status(401).json({ error: 'Geçersiz token tipi' });
    req.portalPatientId = claims.patientId;
    req.portalTenantId = claims.tenantId;
    next();
  } catch {
    res.status(401).json({ error: 'Token süresi dolmuş. Yeni bağlantı için kliniğinizi arayın.' });
  }
}

// ── Public portal endpoints ───────────────────────────────────────────────
router.get('/me', verifyPortalToken, async (req, res) => {
  try {
    const [pat, tenant, teeth, plans, apts, rxs, invs] = await Promise.all([
      query('SELECT id, first_name, last_name, birth_date, phone, email, blood_type, allergies, systemic_diseases, insurance FROM patients WHERE id=$1 AND tenant_id=$2', [req.portalPatientId, req.portalTenantId]),
      query('SELECT name, settings FROM tenants WHERE id=$1', [req.portalTenantId]),
      query('SELECT tooth_no, status, surfaces, notes FROM teeth_records WHERE patient_id=$1 ORDER BY tooth_no', [req.portalPatientId]),
      query('SELECT id, title, status, diagnosis, est_cost, created_at, patient_ok_at FROM treatment_plans WHERE patient_id=$1 AND tenant_id=$2 ORDER BY created_at DESC LIMIT 10', [req.portalPatientId, req.portalTenantId]),
      query('SELECT starts_at, ends_at, type, status FROM appointments WHERE patient_id=$1 AND tenant_id=$2 ORDER BY starts_at DESC LIMIT 20', [req.portalPatientId, req.portalTenantId]),
      query('SELECT rx_date, diagnosis, drugs FROM prescriptions WHERE patient_id=$1 AND tenant_id=$2 ORDER BY rx_date DESC LIMIT 10', [req.portalPatientId, req.portalTenantId]),
      query('SELECT inv_no, inv_date, total, amount_paid, status FROM invoices WHERE patient_id=$1 AND tenant_id=$2 ORDER BY inv_date DESC LIMIT 10', [req.portalPatientId, req.portalTenantId]),
    ]);

    if (!pat.rows.length) return res.status(404).json({ error: 'Hasta bulunamadı' });

    res.json({
      patient: pat.rows[0],
      clinic: tenant.rows[0] || {},
      teeth: teeth.rows,
      plans: plans.rows,
      appointments: apts.rows,
      prescriptions: rxs.rows,
      invoices: invs.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Patient approve treatment plan
router.post('/approve-plan', verifyPortalToken, async (req, res) => {
  try {
    const { plan_id } = req.body;
    const r = await query(
      `UPDATE treatment_plans SET status='approved', patient_ok_at=NOW()
       WHERE id=$1 AND patient_id=$2 AND tenant_id=$3 RETURNING *`,
      [plan_id, req.portalPatientId, req.portalTenantId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Plan bulunamadı' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// /link alias — frontend uses /link, canonical is /token
router.post('/link', authMiddleware, tenantMiddleware, async (req, res) => {
  try {
    const { patient_id } = req.body;
    if (!patient_id) return res.status(400).json({ error: 'patient_id gerekli' });
    const p = await query('SELECT id, first_name, last_name FROM patients WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL',[patient_id, req.tenantId]);
    if (!p.rows.length) return res.status(404).json({ error: 'Hasta bulunamadı' });
    const token = require('jsonwebtoken').sign({ type:'portal', patientId:patient_id, tenantId:req.tenantId }, process.env.JWT_SECRET, { expiresIn:'30d' });
    const url = (process.env.FRONTEND_URL || 'https://disseansim.vercel.app') + '/hasta.html?t=' + token;
    res.json({ token, url, patient: p.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
