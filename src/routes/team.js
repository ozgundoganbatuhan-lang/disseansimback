'use strict';
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');
const { authMiddleware, tenantMiddleware, can } = require('../middleware/auth');
const { q, one, many } = require('../db/postgres');

router.use(authMiddleware, tenantMiddleware);

// Ekip listesi
router.get('/', can('team.manage'), async (req, res) => {
  const members = await many(
    `SELECT m.id, m.role, m.status, m.joined_at, m.branch_id,
            u.id as user_id, u.name, u.email, u.title, u.speciality, u.last_seen_at,
            b.name as branch_name
     FROM memberships m
     JOIN users u ON u.id = m.user_id
     LEFT JOIN branches b ON b.id = m.branch_id
     WHERE m.tenant_id=$1 ORDER BY m.joined_at`,
    [req.tenantId]
  );
  res.json(members);
});

// Üye davet et / ekle
router.post('/', can('team.manage'), async (req, res) => {
  try {
    const { email, name, role, branchId, password } = req.body;
    if (!email || !name || !role) return res.status(400).json({ error: 'Email, isim ve rol zorunlu' });

    const validRoles = ['admin','dentist','assistant','receptionist','accountant'];
    if (!validRoles.includes(role)) return res.status(400).json({ error: 'Geçersiz rol' });

    // Plan limit kontrolü
    const tenant = await one(
      `SELECT t.*, sp.max_users FROM tenants t JOIN subscription_plans sp ON sp.id=t.plan_id WHERE t.id=$1`,
      [req.tenantId]
    );
    if (tenant.max_users) {
      const count = await one('SELECT COUNT(*) as c FROM memberships WHERE tenant_id=$1 AND status=\'active\'', [req.tenantId]);
      if (parseInt(count.c) >= tenant.max_users) {
        return res.status(403).json({ error: `Planınız en fazla ${tenant.max_users} kullanıcı destekliyor` });
      }
    }

    let user = await one('SELECT * FROM users WHERE email=$1', [email.toLowerCase()]);
    if (!user) {
      const pw = password || Math.random().toString(36).slice(2) + 'Ds1!';
      const hash = await bcrypt.hash(pw, 12);
      user = await one(
        `INSERT INTO users (id,email,password_hash,name,email_verified) VALUES ($1,$2,$3,$4,true) RETURNING *`,
        [uuid(), email.toLowerCase(), hash, name]
      );
    }

    const existing = await one('SELECT id FROM memberships WHERE user_id=$1 AND tenant_id=$2', [user.id, req.tenantId]);
    if (existing) return res.status(409).json({ error: 'Bu kullanıcı zaten ekibinizde' });

    const memId = uuid();
    await q(
      `INSERT INTO memberships (id,user_id,tenant_id,branch_id,role,status,invited_by,joined_at) VALUES ($1,$2,$3,$4,$5,'active',$6,NOW())`,
      [memId, user.id, req.tenantId, branchId || null, role, req.user.id]
    );

    const member = await one(
      `SELECT m.*, u.name, u.email, u.title FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.id=$1`, [memId]
    );
    res.json(member);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Rol güncelle
router.put('/:id', can('team.manage'), async (req, res) => {
  try {
    const { role, branchId, status } = req.body;
    const mem = await one('SELECT * FROM memberships WHERE id=$1 AND tenant_id=$2', [req.params.id, req.tenantId]);
    if (!mem) return res.status(404).json({ error: 'Üye bulunamadı' });
    if (mem.role === 'owner' && role !== 'owner') return res.status(403).json({ error: 'Owner rolü değiştirilemez' });

    await q('UPDATE memberships SET role=COALESCE($1,role), branch_id=COALESCE($2,branch_id), status=COALESCE($3,status) WHERE id=$4',
      [role||null, branchId||null, status||null, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Üye kaldır
router.delete('/:id', can('team.manage'), async (req, res) => {
  const mem = await one('SELECT * FROM memberships WHERE id=$1 AND tenant_id=$2', [req.params.id, req.tenantId]);
  if (!mem) return res.status(404).json({ error: 'Üye bulunamadı' });
  if (mem.role === 'owner') return res.status(403).json({ error: 'Klinik sahibi kaldırılamaz' });
  await q('UPDATE memberships SET status=\'removed\' WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
