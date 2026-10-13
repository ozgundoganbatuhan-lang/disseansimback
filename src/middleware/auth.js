'use strict';
const jwt = require('jsonwebtoken');
const { query } = require('../db');

async function authMiddleware(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Token gerekli' });
  try {
    req.claims = jwt.verify(token, process.env.JWT_SECRET);
    const u = await query('SELECT id, email, name, title, speciality, diploma_no, phone, avatar_url FROM users WHERE id=$1', [req.claims.id]);
    if (!u.rows.length) return res.status(401).json({ error: 'Kullanici bulunamadi' });
    req.user = u.rows[0];
    next();
  } catch {
    res.status(401).json({ error: 'Gecersiz token' });
  }
}

async function tenantMiddleware(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Auth gerekli' });
  const tenantId = req.headers['x-tenant-id'] || req.claims.tenantId;
  if (!tenantId) return res.status(400).json({ error: 'Tenant ID gerekli' });
  try {
    const mem = await query(
      'SELECT m.role, m.status, m.branch_id, t.id as tid, t.name as tname, t.plan, t.plan_status, t.trial_ends_at, t.max_users, t.max_branches, t.max_patients, t.ai_tokens_monthly, t.storage_gb, t.settings FROM memberships m JOIN tenants t ON t.id=m.tenant_id WHERE m.user_id=$1 AND m.tenant_id=$2',
      [req.user.id, tenantId]
    );
    if (!mem.rows.length) return res.status(403).json({ error: 'Bu workspace erisiminiz yok' });
    const m = mem.rows[0];
    if (m.status !== 'active') return res.status(403).json({ error: 'Hesabiniz askiya alindi' });
    const now = new Date();
    const trialEnd = new Date(m.trial_ends_at);
    if (m.plan === 'trial' && now > trialEnd) req.planExpired = true;
    // Süresi dolan deneme salt okunur: kayıtlar görülebilir/dışa aktarılabilir, yeni işlem için plan gerekir.
    const billingPath = /^\/api\/(subscriptions|iyzico|auth)\b/.test(req.originalUrl || '');
    if (req.planExpired && req.method !== 'GET' && !billingPath) {
      return res.status(402).json({ error: 'Deneme süreniz doldu. Devam etmek için planınızı aktifleştirin.', upgrade: true, code: 'TRIAL_EXPIRED' });
    }
    req.tenantId = tenantId;
    req.membership = m;
    next();
  } catch (err) {
    res.status(500).json({ error: 'Sunucu hatasi' });
  }
}

const PERMISSIONS = {
  'patient.read':        ['owner','admin','dentist','assistant','receptionist','accountant'],
  'patient.write':       ['owner','admin','dentist','assistant','receptionist'],
  'patient.delete':      ['owner','admin'],
  'appointment.read':    ['owner','admin','dentist','assistant','receptionist'],
  'appointment.write':   ['owner','admin','dentist','assistant','receptionist'],
  'appointment.delete':  ['owner','admin'],
  'treatment.read':      ['owner','admin','dentist','assistant'],
  'treatment.write':     ['owner','admin','dentist'],
  'billing.read':        ['owner','admin','accountant','receptionist'],
  'billing.write':       ['owner','admin','accountant'],
  'billing.manage':      ['owner','admin'],
  'inventory.read':      ['owner','admin','dentist','assistant'],
  'inventory.write':     ['owner','admin'],
  'sterilization.write': ['owner','admin','dentist','assistant'],
  'reports.view':        ['owner','admin','accountant'],
  'team.manage':         ['owner','admin'],
  'settings.manage':     ['owner'],
};

function can(permission) {
  return function(req, res, next) {
    const role = req.membership && req.membership.role;
    if (!role) return res.status(403).json({ error: 'Uyelik bulunamadi' });
    const allowed = PERMISSIONS[permission] || [];
    if (!allowed.includes(role)) return res.status(403).json({ error: 'Bu islem icin yetkiniz yok' });
    next();
  };
}

function requireFeature(feature) {
  const PLAN_FEATURES = {
    reports_advanced: ['growth','enterprise'],
    multi_branch:     ['growth','enterprise'],
    ai_notes:         ['growth','enterprise'],
    team_management:  ['growth','enterprise'],
  };
  return function(req, res, next) {
    if (req.planExpired) return res.status(402).json({ error: 'Trial suresi doldu', upgrade: true });
    const plan = req.membership && req.membership.plan;
    const required = PLAN_FEATURES[feature];
    if (required && !required.includes(plan)) return res.status(402).json({ error: 'Bu ozellik ustte plan gerektirir', upgrade: true, requiredPlan: required[0] });
    next();
  };
}

async function auditLog(tenantId, userId, action, entityType, entityId, before, after, req) {
  try {
    await query(
      'INSERT INTO audit_logs (tenant_id, user_id, action, entity_type, entity_id, before_data, after_data, ip_address, user_agent) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [tenantId, userId, action, entityType, entityId, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, req && req.ip, req && req.headers['user-agent']]
    );
  } catch(e) {}
}

module.exports = { authMiddleware, tenantMiddleware, can, requireFeature, auditLog };
