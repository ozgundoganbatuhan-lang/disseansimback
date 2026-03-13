'use strict';
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { query, withTransaction } = require('../db');
const { authMiddleware } = require('../middleware/auth');

const sign = (payload) => jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '15m' });
const signRefresh = (id) => jwt.sign({ id, type: 'refresh' }, process.env.JWT_SECRET, { expiresIn: '30d' });

function safeUser(u, m) {
  return {
    id: u.id, email: u.email, name: u.name, title: u.title,
    speciality: u.speciality, diplomaNo: u.diploma_no, phone: u.phone,
    membership: m ? {
      role: m.role, tenantId: m.tenant_id || m.tid,
      tenantName: m.tname, plan: m.plan, planStatus: m.plan_status,
      trialEndsAt: m.trial_ends_at, maxUsers: m.max_users, maxPatients: m.max_patients,
    } : null
  };
}

router.post('/register', async (req, res) => {
  try {
    const { email, password, name, clinicName, title, terms } = req.body;
    if (!email || !password || !name) return res.status(400).json({ error: 'Zorunlu alanlar eksik' });
    if (!terms) return res.status(400).json({ error: 'Kullanim kosullari kabul edilmeli' });
    if (password.length < 8) return res.status(400).json({ error: 'Sifre en az 8 karakter olmali' });
    const existing = await query('SELECT id FROM users WHERE email=$1', [email.toLowerCase()]);
    if (existing.rows.length) return res.status(409).json({ error: 'Bu e-posta zaten kayitli' });
    const hash = await bcrypt.hash(password, 12);
    const result = await withTransaction(async (client) => {
      const ur = await client.query('INSERT INTO users (email,password_hash,name,title,email_verified) VALUES ($1,$2,$3,$4,true) RETURNING *', [email.toLowerCase(), hash, name, title||'Dr.']);
      const user = ur.rows[0];
      const slug = ((clinicName||name).toLowerCase().replace(/[^a-z0-9]/g,'-').slice(0,40)) + '-' + Math.random().toString(36).slice(2,6);
      const tr = await client.query('INSERT INTO tenants (slug,name,plan,plan_status) VALUES ($1,$2,$3,$4) RETURNING *', [slug, clinicName||(name+' Klinigi'), 'trial', 'active']);
      const tenant = tr.rows[0];
      await client.query('INSERT INTO branches (tenant_id,name,is_main) VALUES ($1,$2,true)', [tenant.id, tenant.name]);
      const mr = await client.query('INSERT INTO memberships (user_id,tenant_id,role,status,joined_at) VALUES ($1,$2,$3,$4,NOW()) RETURNING *', [user.id, tenant.id, 'owner', 'active']);
      return { user, tenant, membership: mr.rows[0] };
    });
    const { user, tenant, membership } = result;
    const accessToken = sign({ id: user.id, tenantId: tenant.id });
    const refreshToken = signRefresh(user.id);
    await query("UPDATE users SET refresh_tokens='[{\"token\":\"'+$1+'\",\"createdAt\":\"'+new Date().toISOString()+'\"}]'::jsonb WHERE id=$2", [refreshToken, user.id]).catch(()=>{});
    const mem = { ...membership, tid: tenant.id, tname: tenant.name, plan: tenant.plan, plan_status: tenant.plan_status, trial_ends_at: tenant.trial_ends_at, max_users: tenant.max_users, max_patients: tenant.max_patients };
    res.status(201).json({ accessToken, refreshToken, user: safeUser(user, mem) });
  } catch(err) { console.error(err.message); res.status(500).json({ error: 'Sunucu hatasi' }); }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'E-posta ve sifre gerekli' });
    const ur = await query('SELECT * FROM users WHERE email=$1', [email.toLowerCase()]);
    if (!ur.rows.length) return res.status(401).json({ error: 'E-posta veya sifre hatali' });
    const user = ur.rows[0];
    if (!await bcrypt.compare(password, user.password_hash)) return res.status(401).json({ error: 'E-posta veya sifre hatali' });
    const mr = await query('SELECT m.*, t.id as tid, t.name as tname, t.plan, t.plan_status, t.trial_ends_at, t.max_users, t.max_patients FROM memberships m JOIN tenants t ON t.id=m.tenant_id WHERE m.user_id=$1 AND m.status=$2 ORDER BY m.joined_at ASC LIMIT 1', [user.id, 'active']);
    if (!mr.rows.length) return res.status(403).json({ error: 'Aktif workspace bulunamadi' });
    const membership = mr.rows[0];
    const tenants = await query('SELECT t.id, t.name, t.slug, t.plan, m.role FROM tenants t JOIN memberships m ON m.tenant_id=t.id WHERE m.user_id=$1 AND m.status=$2', [user.id, 'active']);
    const accessToken = sign({ id: user.id, tenantId: membership.tenant_id });
    const refreshToken = signRefresh(user.id);
    let tokens = Array.isArray(user.refresh_tokens) ? user.refresh_tokens : [];
    tokens = [{ token: refreshToken, createdAt: new Date().toISOString() }, ...tokens].slice(0,5);
    await query('UPDATE users SET refresh_tokens=$1, last_seen_at=NOW() WHERE id=$2', [JSON.stringify(tokens), user.id]);
    res.json({ accessToken, refreshToken, user: safeUser(user, membership), tenants: tenants.rows });
  } catch(err) { console.error(err.message); res.status(500).json({ error: 'Sunucu hatasi' }); }
});

router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(400).json({ error: 'Refresh token gerekli' });
    let claims;
    try { claims = jwt.verify(refreshToken, process.env.JWT_SECRET); } catch { return res.status(401).json({ error: 'Gecersiz refresh token' }); }
    if (claims.type !== 'refresh') return res.status(401).json({ error: 'Gecersiz token tipi' });
    const ur = await query('SELECT * FROM users WHERE id=$1', [claims.id]);
    if (!ur.rows.length) return res.status(401).json({ error: 'Kullanici bulunamadi' });
    const user = ur.rows[0];
    const tokens = Array.isArray(user.refresh_tokens) ? user.refresh_tokens : [];
    if (!tokens.find(t => t.token === refreshToken)) return res.status(401).json({ error: 'Token iptal edilmis' });
    const mr = await query('SELECT m.tenant_id FROM memberships m WHERE m.user_id=$1 AND m.status=$2 LIMIT 1', [user.id, 'active']);
    if (!mr.rows.length) return res.status(403).json({ error: 'Aktif membership yok' });
    const newAccess = sign({ id: user.id, tenantId: mr.rows[0].tenant_id });
    const newRefresh = signRefresh(user.id);
    const newTokens = [{ token: newRefresh, createdAt: new Date().toISOString() }, ...tokens.filter(t => t.token !== refreshToken)].slice(0,5);
    await query('UPDATE users SET refresh_tokens=$1 WHERE id=$2', [JSON.stringify(newTokens), user.id]);
    res.json({ accessToken: newAccess, refreshToken: newRefresh });
  } catch(err) { res.status(500).json({ error: 'Sunucu hatasi' }); }
});

router.get('/me', authMiddleware, async (req, res) => {
  const tenantId = req.headers['x-tenant-id'] || req.claims.tenantId;
  let membership = null;
  if (tenantId) {
    const mr = await query('SELECT m.*, t.id as tid, t.name as tname, t.plan, t.plan_status, t.trial_ends_at, t.max_users, t.max_patients FROM memberships m JOIN tenants t ON t.id=m.tenant_id WHERE m.user_id=$1 AND m.tenant_id=$2', [req.user.id, tenantId]);
    membership = mr.rows[0] || null;
  }
  const tenants = await query('SELECT t.id, t.name, t.slug, t.plan, m.role FROM tenants t JOIN memberships m ON m.tenant_id=t.id WHERE m.user_id=$1 AND m.status=$2', [req.user.id, 'active']);
  res.json({ user: safeUser(req.user, membership), tenants: tenants.rows });
});

router.put('/password', authMiddleware, async (req, res) => {
  try {
    const { current, next: newPass } = req.body;
    if (!current || !newPass || newPass.length < 8) return res.status(400).json({ error: 'Gecersiz sifre' });
    const ur = await query('SELECT * FROM users WHERE id=$1', [req.user.id]);
    if (!await bcrypt.compare(current, ur.rows[0].password_hash)) return res.status(400).json({ error: 'Mevcut sifre hatali' });
    await query('UPDATE users SET password_hash=$1, refresh_tokens=$2 WHERE id=$3', [await bcrypt.hash(newPass, 12), '[]', req.user.id]);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: 'Sunucu hatasi' }); }
});

router.post('/logout', authMiddleware, async (req, res) => {
  const { refreshToken } = req.body;
  if (refreshToken) {
    const ur = await query('SELECT refresh_tokens FROM users WHERE id=$1', [req.user.id]);
    if (ur.rows.length) {
      const tokens = (ur.rows[0].refresh_tokens || []).filter(t => t.token !== refreshToken);
      await query('UPDATE users SET refresh_tokens=$1 WHERE id=$2', [JSON.stringify(tokens), req.user.id]);
    }
  }
  res.json({ ok: true });
});

module.exports = router;
