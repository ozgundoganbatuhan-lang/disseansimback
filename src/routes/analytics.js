'use strict';
const router = require('express').Router();
const { authMiddleware, tenantMiddleware, can } = require('../middleware/auth');
const { one, many } = require('../db/postgres');

router.use(authMiddleware, tenantMiddleware, can('reports.view'));

// Dashboard KPIs
router.get('/dashboard', async (req, res) => {
  try {
    const tid = req.tenantId;
    const today = new Date().toISOString().slice(0,10);
    const month = today.slice(0,7);
    const [
      totalPatients, newPatientsMonth, todayApts, monthApts,
      completedToday, monthRevenue, pendingBalance, activePlans,
      noShowRate, upcomingApts
    ] = await Promise.all([
      one(`SELECT COUNT(*) c FROM patients WHERE tenant_id=$1 AND deleted_at IS NULL`, [tid]),
      one(`SELECT COUNT(*) c FROM patients WHERE tenant_id=$1 AND DATE_TRUNC('month',created_at)=DATE_TRUNC('month',NOW()) AND deleted_at IS NULL`, [tid]),
      one(`SELECT COUNT(*) c FROM appointments WHERE tenant_id=$1 AND starts_at::date=$2`, [tid,today]),
      one(`SELECT COUNT(*) c FROM appointments WHERE tenant_id=$1 AND DATE_TRUNC('month',starts_at)=DATE_TRUNC('month',NOW()) AND status!='cancelled'`, [tid]),
      one(`SELECT COUNT(*) c FROM appointments WHERE tenant_id=$1 AND starts_at::date=$2 AND status='completed'`, [tid,today]),
      one(`SELECT COALESCE(SUM(amount),0) v FROM payments p JOIN invoices i ON i.id=p.invoice_id WHERE i.tenant_id=$1 AND DATE_TRUNC('month',p.paid_at)=DATE_TRUNC('month',NOW())`, [tid]),
      one(`SELECT COALESCE(SUM(total-amount_paid),0) v FROM invoices WHERE tenant_id=$1 AND status IN ('draft','partial','overdue')`, [tid]),
      one(`SELECT COUNT(*) c FROM treatment_plans WHERE tenant_id=$1 AND status IN ('draft','approved','in_progress')`, [tid]),
      one(`SELECT CASE WHEN COUNT(*)=0 THEN 0 ELSE ROUND(100.0*SUM(CASE WHEN no_show THEN 1 ELSE 0 END)/COUNT(*),1) END r FROM appointments WHERE tenant_id=$1 AND starts_at > NOW()-INTERVAL '30 days'`, [tid]),
      many(`SELECT a.*, p.first_name, p.last_name, u.name as doctor_name FROM appointments a
            JOIN patients p ON p.id=a.patient_id JOIN users u ON u.id=a.doctor_id
            WHERE a.tenant_id=$1 AND a.starts_at >= NOW() AND a.status='scheduled'
            ORDER BY a.starts_at LIMIT 8`, [tid]),
    ]);

    res.json({
      kpis: {
        totalPatients: +totalPatients.c,
        newPatientsMonth: +newPatientsMonth.c,
        todayApts: +todayApts.c,
        monthApts: +monthApts.c,
        completedToday: +completedToday.c,
        monthRevenue: +monthRevenue.v,
        pendingBalance: +pendingBalance.v,
        activePlans: +activePlans.c,
        noShowRate: +noShowRate.r,
      },
      upcomingApts
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Revenue report (last 12 months)
router.get('/revenue', async (req, res) => {
  try {
    const rows = await many(
      `SELECT TO_CHAR(DATE_TRUNC('month', p.paid_at), 'YYYY-MM') as month,
              COALESCE(SUM(p.amount),0) as revenue,
              COUNT(DISTINCT i.patient_id) as unique_patients
       FROM payments p
       JOIN invoices i ON i.id=p.invoice_id
       WHERE i.tenant_id=$1 AND p.paid_at >= NOW()-INTERVAL '12 months'
       GROUP BY 1 ORDER BY 1`,
      [req.tenantId]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Appointment statistics
router.get('/appointments', async (req, res) => {
  try {
    const { from, to } = req.query;
    const f = from || new Date(Date.now()-30*24*60*60*1000).toISOString().slice(0,10);
    const t = to || new Date().toISOString().slice(0,10);

    const byStatus = await many(
      `SELECT status, COUNT(*) c FROM appointments WHERE tenant_id=$1 AND starts_at::date BETWEEN $2 AND $3 GROUP BY status`,
      [req.tenantId, f, t]
    );
    const byType = await many(
      `SELECT type, COUNT(*) c FROM appointments WHERE tenant_id=$1 AND starts_at::date BETWEEN $2 AND $3 AND status!='cancelled' GROUP BY type ORDER BY c DESC LIMIT 10`,
      [req.tenantId, f, t]
    );
    const byDoctor = await many(
      `SELECT u.name, COUNT(*) c, COUNT(*) FILTER (WHERE a.status='completed') completed
       FROM appointments a JOIN users u ON u.id=a.doctor_id
       WHERE a.tenant_id=$1 AND a.starts_at::date BETWEEN $2 AND $3
       GROUP BY u.name ORDER BY c DESC`,
      [req.tenantId, f, t]
    );
    const daily = await many(
      `SELECT starts_at::date as date, COUNT(*) c FROM appointments
       WHERE tenant_id=$1 AND starts_at::date BETWEEN $2 AND $3 AND status!='cancelled'
       GROUP BY 1 ORDER BY 1`,
      [req.tenantId, f, t]
    );

    res.json({ byStatus, byType, byDoctor, daily });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Patient demographics
router.get('/patients', async (req, res) => {
  try {
    const byInsurance = await many(
      `SELECT COALESCE(insurance,'Sigortasız') as ins, COUNT(*) c FROM patients WHERE tenant_id=$1 AND deleted_at IS NULL GROUP BY 1 ORDER BY c DESC`,
      [req.tenantId]
    );
    const byGender = await many(
      `SELECT COALESCE(gender,'Belirtilmedi') g, COUNT(*) c FROM patients WHERE tenant_id=$1 AND deleted_at IS NULL GROUP BY 1`,
      [req.tenantId]
    );
    const newByMonth = await many(
      `SELECT TO_CHAR(DATE_TRUNC('month',created_at),'YYYY-MM') m, COUNT(*) c
       FROM patients WHERE tenant_id=$1 AND deleted_at IS NULL AND created_at >= NOW()-INTERVAL '12 months'
       GROUP BY 1 ORDER BY 1`,
      [req.tenantId]
    );
    res.json({ byInsurance, byGender, newByMonth });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Inventory low stock alert
router.get('/inventory-alerts', async (req, res) => {
  try {
    const low = await many(
      `SELECT * FROM inventory_items WHERE tenant_id=$1 AND stock_qty <= min_qty ORDER BY (min_qty-stock_qty) DESC`,
      [req.tenantId]
    );
    const expiring = await many(
      `SELECT * FROM inventory_items WHERE tenant_id=$1 AND expiry_date IS NOT NULL AND expiry_date <= NOW()+INTERVAL '30 days' ORDER BY expiry_date`,
      [req.tenantId]
    );
    res.json({ lowStock: low, expiringSoon: expiring });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
