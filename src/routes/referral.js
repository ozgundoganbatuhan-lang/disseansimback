'use strict';
const router = require('express').Router();
const { authMiddleware, tenantMiddleware } = require('../middleware/auth');
const { query } = require('../db');
const { v4: uuidv4 } = require('uuid');

router.use(authMiddleware, tenantMiddleware);

// Get referral info for tenant
router.get('/', async (req, res) => {
  try {
    const tenant = await query('SELECT settings FROM tenants WHERE id=$1', [req.tenantId]);
    const settings = tenant.rows[0].settings || {};
    let code = settings.referral_code;
    if (!code) {
      code = 'DS-' + Math.random().toString(36).slice(2,8).toUpperCase();
      await query("UPDATE tenants SET settings=jsonb_set(settings,'{referral_code}',$1::jsonb) WHERE id=$2", [JSON.stringify(code), req.tenantId]);
    }
    const refs = await query("SELECT COUNT(*) as c FROM tenants WHERE settings->>'referred_by'=$1", [code]);
    const credits = await query("SELECT COALESCE(SUM((settings->>'referral_credits')::int),0) as v FROM tenants WHERE id=$1", [req.tenantId]);
    res.json({ code, referralCount: parseInt(refs.rows[0].c), credits: parseInt(credits.rows[0].v)||0, link: (process.env.FRONTEND_URL||'https://dis.seansim.com') + '/giris?ref=' + code });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
