'use strict';
const router = require('express').Router();
const { authMiddleware, tenantMiddleware } = require('../middleware/auth');
const { q, one } = require('../db/postgres');
const iyzico = require('../services/iyzico');

// Ödeme formu başlat
router.post('/init', auth, async (req, res) => {
  try {
    const { planKey, callbackUrl } = req.body;
    const validPlans = ['solo_monthly','solo_annual','klinik_monthly','klinik_annual','poliklinik_monthly','poliklinik_annual'];
    if (!validPlans.includes(planKey)) return res.status(400).json({ error: 'Geçersiz plan' });

    const user = await one('SELECT * FROM users WHERE id=$1', [req.user.id]);
    const tenant = await one('SELECT * FROM tenants WHERE id=$1', [req.tenantId]);

    const result = await iyzico.initCheckoutForm({
      tenant, user,
      planKey,
      callbackUrl: callbackUrl || `${process.env.APP_URL}/api/iyzico/callback`,
      conversationId: `ds_${req.tenantId}_${Date.now()}`
    });

    // Kaydediyoruz token bilgisini
    await q(`UPDATE tenants SET settings = settings || $1 WHERE id=$2`,
      [JSON.stringify({ pending_iyzico_token: result.token, pending_plan: planKey }), req.tenantId]);

    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// iyzico callback (3DS sonrası)
router.post('/callback', async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).send('Token eksik');

    const result = await iyzico.retrieveCheckout(token);

    if (result.status === 'success' && result.paymentStatus === 'SUCCESS') {
      // Hangi tenant bu token'a sahip?
      const tenant = await one(
        `SELECT * FROM tenants WHERE settings->>'pending_iyzico_token' = $1`, [token]
      );
      if (tenant) {
        const planKey = tenant.settings.pending_plan || 'solo_monthly';
        const planId = planKey.split('_')[0];

        await q(`UPDATE tenants SET
          plan_id=$1,
          plan_status='active',
          iyzico_subscription_id=$2,
          next_billing_at=NOW() + INTERVAL '1 month',
          settings = settings - 'pending_iyzico_token' - 'pending_plan'
          WHERE id=$3`,
          [planId, result.paymentId || token, tenant.id]
        );
      }
      // Başarı sayfasına yönlendir
      res.redirect(`${process.env.FRONTEND_URL}/app.html?payment=success`);
    } else {
      res.redirect(`${process.env.FRONTEND_URL}/app.html?payment=failed&msg=${encodeURIComponent(result.errorMessage||'Ödeme başarısız')}`);
    }
  } catch (e) {
    res.redirect(`${process.env.FRONTEND_URL}/app.html?payment=failed&msg=${encodeURIComponent(e.message)}`);
  }
});

// Abonelik bilgisi
router.get('/subscription', auth, async (req, res) => {
  try {
    const tenant = await one('SELECT * FROM tenants JOIN subscription_plans ON subscription_plans.id=tenants.plan_id WHERE tenants.id=$1', [req.tenantId]);
    res.json({
      planId: tenant.plan_id,
      planName: tenant.name,
      planStatus: tenant.plan_status,
      trialEndsAt: tenant.trial_ends_at,
      nextBillingAt: tenant.next_billing_at,
      priceMonthly: tenant.price_monthly,
      features: tenant.features,
      maxUsers: tenant.max_users,
      maxBranches: tenant.max_branches
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Aboneliği iptal et
router.post('/cancel', auth, async (req, res) => {
  try {
    const tenant = await one('SELECT * FROM tenants WHERE id=$1', [req.tenantId]);
    if (tenant.iyzico_subscription_id) {
      await iyzico.cancelSubscription(tenant.iyzico_subscription_id).catch(e => console.warn('iyzico cancel:', e));
    }
    await q(`UPDATE tenants SET plan_status='cancelled' WHERE id=$1`, [req.tenantId]);
    res.json({ ok: true, message: 'Aboneliğiniz dönem sonunda sona erecek.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Fatura geçmişi (iyzico işlemleri)
router.get('/invoices', auth, async (req, res) => {
  try {
    // İleride iyzipay transaction history ile genişletilebilir
    const tenant = await one('SELECT * FROM tenants WHERE id=$1', [req.tenantId]);
    res.json({
      subscriptionId: tenant.iyzico_subscription_id,
      note: 'Fatura geçmişi iyzico panelinden görüntülenebilir.'
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
