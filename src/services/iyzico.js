'use strict';
const Iyzipay = require('iyzipay');
const { v4: uuidv4 } = require('uuid');
const { query, withTransaction } = require('../db');

const iyzipay = new Iyzipay({
  apiKey: process.env.IYZICO_API_KEY || 'sandbox-xxx',
  secretKey: process.env.IYZICO_SECRET_KEY || 'sandbox-xxx',
  uri: process.env.IYZICO_URI || 'https://sandbox-api.iyzipay.com'
});

const KDV_RATE = process.env.KDV_RATE != null ? parseFloat(process.env.KDV_RATE) : 0.20;

const PLAN_PRICES = {
  starter:    { monthly: 890.00,  annual: 8900.00  },
  growth:     { monthly: 1690.00, annual: 16900.00 },
  enterprise: { monthly: null, annual: null }
};

const PLAN_LIMITS = {
  starter:    { maxUsers: 2, maxBranches: 1, maxPatients: 2000,  aiTokens: 50000,  storageGb: 5  },
  growth:     { maxUsers: 8, maxBranches: 3, maxPatients: null,  aiTokens: 200000, storageGb: 20 },
  enterprise: { maxUsers: null, maxBranches: null, maxPatients: null, aiTokens: null, storageGb: null }
};

async function initCheckout({ tenant, user, plan, period, callbackUrl, ip }) {
  const price = PLAN_PRICES[plan] && PLAN_PRICES[plan][period];
  if (!price) throw new Error('Gecersiz plan veya donem');
  const conversationId = uuidv4();
  // Liste fiyatları KDV hariç; tahsilatta KDV eklenir.
  const amount = (Math.round(price * (1 + KDV_RATE) * 100) / 100).toFixed(2);
  const request = {
    locale: Iyzipay.LOCALE.TR,
    conversationId,
    price: amount,
    paidPrice: amount,
    currency: Iyzipay.CURRENCY.TRY,
    basketId: 'DS-' + tenant.id.slice(0,8) + '-' + Date.now(),
    paymentGroup: Iyzipay.PAYMENT_GROUP.SUBSCRIPTION,
    callbackUrl: callbackUrl || (process.env.APP_URL + '/api/subscriptions/callback'),
    enabledInstallments: [1, 2, 3, 6, 9, 12],
    buyer: {
      id: user.id,
      name: (user.name.split(' ')[0] || 'Musteri'),
      surname: (user.name.split(' ').slice(1).join(' ') || 'Hesap'),
      gsmNumber: user.phone || '+905000000000',
      email: user.email,
      identityNumber: '11111111111',
      registrationAddress: 'Turkiye',
      ip: ip || '85.34.78.112',
      city: 'Istanbul',
      country: 'Turkey',
    },
    shippingAddress: { contactName: user.name, city: 'Istanbul', country: 'Turkey', address: 'Turkiye' },
    billingAddress:  { contactName: user.name, city: 'Istanbul', country: 'Turkey', address: 'Turkiye' },
    basketItems: [{
      id: 'PLAN-' + plan.toUpperCase(),
      name: 'DisSeansim ' + plan + ' - ' + (period === 'monthly' ? 'Aylik' : 'Yillik'),
      category1: 'SaaS Abonelik',
      itemType: Iyzipay.BASKET_ITEM_TYPE.VIRTUAL,
      price: amount,
    }]
  };
  return new Promise((resolve, reject) => {
    iyzipay.checkoutFormInitialize.create(request, function(err, result) {
      if (err) return reject(new Error('iyzico baglanti hatasi'));
      if (result.status !== 'success') return reject(new Error(result.errorMessage || 'Odeme baslatılamadi'));
      resolve({ checkoutFormContent: result.checkoutFormContent, token: result.token, conversationId, plan, period, amount });
    });
  });
}

async function retrieveCheckout(token) {
  return new Promise((resolve, reject) => {
    iyzipay.checkoutForm.retrieve({
      locale: Iyzipay.LOCALE.TR,
      conversationId: uuidv4(),
      token
    }, function(err, result) {
      if (err) return reject(new Error('iyzico retrieve hatasi'));
      resolve(result);
    });
  });
}

async function processCallback({ token, tenantId, plan, period }) {
  const result = await retrieveCheckout(token);
  if (result.status !== 'success' || result.paymentStatus !== 'SUCCESS') {
    await query(
      'INSERT INTO subscription_payments (tenant_id, iyzico_token, amount, plan, period, status, error_code, error_message) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [tenantId, token, 0, plan, period, 'failed', result.errorCode, result.errorMessage]
    );
    throw new Error(result.errorMessage || 'Odeme basarisiz');
  }
  const price = PLAN_PRICES[plan][period];
  const paid = parseFloat(result.paidPrice) || Math.round(price * (1 + KDV_RATE) * 100) / 100; // KDV dahil tahsil edilen
  const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.starter;
  const now = new Date();
  const periodStart = now.toISOString().slice(0,10);
  const d2 = new Date(now);
  d2.setMonth(d2.getMonth() + (period === 'annual' ? 12 : 1));
  const periodEnd = d2.toISOString().slice(0,10);
  await withTransaction(async function(client) {
    await client.query(
      'UPDATE tenants SET plan=$1, plan_status=$2, trial_ends_at=NOW()+INTERVAL \'100 years\', next_billing_date=$3, max_users=$4, max_branches=$5, max_patients=$6, ai_tokens_monthly=$7, storage_gb=$8, updated_at=NOW() WHERE id=$9',
      [plan, 'active', periodEnd, limits.maxUsers, limits.maxBranches, limits.maxPatients, limits.aiTokens||50000, limits.storageGb||5, tenantId]
    );
    await client.query(
      'INSERT INTO subscription_payments (tenant_id, iyzico_payment_id, iyzico_token, amount, currency, plan, period, status, paid_at, period_start, period_end) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),$9,$10)',
      [tenantId, result.paymentId, token, paid, 'TRY', plan, period, 'success', periodStart, periodEnd]
    );
  });
  return { success: true, plan, periodEnd };
}

async function cancelSubscription(tenantId) {
  await query('UPDATE tenants SET plan_status=$1, updated_at=NOW() WHERE id=$2', ['cancelled', tenantId]);
  return { success: true };
}

module.exports = { initCheckout, retrieveCheckout, processCallback, cancelSubscription, PLAN_PRICES, PLAN_LIMITS, KDV_RATE };
