'use strict';
const router = require('express').Router();
const { authMiddleware, tenantMiddleware } = require('../middleware/auth');
const { initCheckout, processCallback, cancelSubscription, PLAN_PRICES } = require('../services/iyzico');
const { query } = require('../db');

// Get plans + current status
router.get('/plans', async (req, res) => {
  const plans = await query('SELECT * FROM subscription_plans ORDER BY CASE id WHEN $1 THEN 1 WHEN $2 THEN 2 WHEN $3 THEN 3 WHEN $4 THEN 4 END', ['trial','starter','growth','enterprise']);
  res.json({ plans: plans.rows, prices: PLAN_PRICES });
});

// Initiate checkout
router.post('/checkout', authMiddleware, tenantMiddleware, async (req, res) => {
  try {
    const { plan, period } = req.body;
    if (!plan || !period) return res.status(400).json({ error: 'Plan ve donem gerekli' });
    if (!['starter','growth','enterprise'].includes(plan)) return res.status(400).json({ error: 'Gecersiz plan' });
    if (!['monthly','annual'].includes(period)) return res.status(400).json({ error: 'Gecersiz donem' });
    const tenant = await query('SELECT * FROM tenants WHERE id=$1', [req.tenantId]);
    const result = await initCheckout({
      tenant: tenant.rows[0], user: req.user,
      plan, period,
      callbackUrl: process.env.APP_URL + '/api/subscriptions/callback',
      ip: req.ip
    });
    // Store pending info in session
    await query('UPDATE tenants SET settings=jsonb_set(settings,$1,$2::jsonb) WHERE id=$3', ['{pending_checkout}', JSON.stringify({ token: result.token, plan, period, ts: Date.now() }), req.tenantId]);
    res.json(result);
  } catch(err) {
    console.error('Checkout:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// iyzico callback (3D redirect)
router.post('/callback', async (req, res) => {
  try {
    const token = req.body.token;
    if (!token) return res.redirect(process.env.FRONTEND_URL + '/odeme?status=error');
    // Find tenant by token
    const tr = await query("SELECT id, settings FROM tenants WHERE settings->'pending_checkout'->>'token' = $1", [token]);
    if (!tr.rows.length) return res.redirect(process.env.FRONTEND_URL + '/odeme?status=error&reason=session');
    const tenant = tr.rows[0];
    const pending = tenant.settings.pending_checkout;
    const result = await processCallback({ token, tenantId: tenant.id, plan: pending.plan, period: pending.period });
    // Clear pending
    await query('UPDATE tenants SET settings=settings - $1 WHERE id=$2', ['pending_checkout', tenant.id]);
    res.redirect(process.env.FRONTEND_URL + '/odeme?status=success&plan=' + result.plan);
  } catch(err) {
    console.error('Callback:', err.message);
    res.redirect(process.env.FRONTEND_URL + '/odeme?status=error&reason=' + encodeURIComponent(err.message));
  }
});

// Get subscription history
router.get('/history', authMiddleware, tenantMiddleware, async (req, res) => {
  const payments = await query('SELECT * FROM subscription_payments WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 20', [req.tenantId]);
  const tenant = await query('SELECT plan, plan_status, trial_ends_at, next_billing_date FROM tenants WHERE id=$1', [req.tenantId]);
  res.json({ payments: payments.rows, subscription: tenant.rows[0] });
});

// Cancel
router.post('/cancel', authMiddleware, tenantMiddleware, async (req, res) => {
  try {
    if (req.membership.role !== 'owner') return res.status(403).json({ error: 'Sadece hesap sahibi iptal edebilir' });
    await cancelSubscription(req.tenantId);
    res.json({ ok: true, message: 'Abonelik iptal edildi. Donem sonuna kadar erisim devam eder.' });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
