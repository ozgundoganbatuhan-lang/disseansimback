'use strict';
// Hastanın telefonundan imza: /api/public/onam/:token (giriş gerektirmez, 72 saat geçerli, tek kullanımlık)
const router = require('express').Router();
const { query } = require('../db');

/** data:image/png;base64,… ve gerçekten PNG mi (sihirli baytlar) */
function validPng(sig) {
  if (typeof sig !== 'string' || !sig.startsWith('data:image/png;base64,') || sig.length > 400000) return false;
  const b64 = sig.slice(22);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return false;
  const buf = Buffer.from(b64, 'base64');
  return buf.length > 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
}
async function byToken(token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 64) return null;
  return (await query(`SELECT c.id, c.title, c.body, c.signed_at, c.token_expires, pt.first_name, pt.last_name, t.name tenant_name
    FROM consent_forms c JOIN patients pt ON pt.id=c.patient_id JOIN tenants t ON t.id=c.tenant_id WHERE c.token=$1`, [token])).rows[0];
}
router.get('/onam/:token', async (req, res) => {
  try {
    const c = await byToken(req.params.token);
    if (!c) return res.status(404).json({ error: 'Onam bağlantısı bulunamadı.' });
    if (c.signed_at) return res.json({ signed: true, title: c.title, tenant_name: c.tenant_name });
    if (new Date(c.token_expires) < new Date()) return res.status(410).json({ error: 'Bağlantının süresi doldu. Kliniğinizden yeni bağlantı isteyin.' });
    res.json({ title: c.title, body: c.body, tenant_name: c.tenant_name, patient: `${c.first_name} ${c.last_name.charAt(0)}.` });
  } catch (e) { res.status(500).json({ error: 'Bir hata oluştu.' }); }
});
router.post('/onam/:token', async (req, res) => {
  try {
    const c = await byToken(req.params.token);
    if (!c || c.signed_at) return res.status(404).json({ error: 'Bu onam zaten imzalanmış ya da bulunamadı.' });
    if (new Date(c.token_expires) < new Date()) return res.status(410).json({ error: 'Bağlantının süresi doldu.' });
    const sig = req.body.signature, name = String(req.body.signer_name || '').trim().slice(0, 120);
    if (!validPng(sig)) return res.status(400).json({ error: 'İmza alınamadı.' });
    if (name.length < 3) return res.status(400).json({ error: 'Adınızı ve soyadınızı yazın.' });
    if (req.body.accept !== true) return res.status(400).json({ error: 'Metni okuduğunuzu onaylayın.' });
    const u = await query(`UPDATE consent_forms SET signed_at=NOW(), signer_name=$1, signature=$2, signed_ip=$3, signed_ua=$4, token=NULL
      WHERE id=$5 AND signed_at IS NULL AND token_expires > NOW()`, [name, sig, req.ip, String(req.headers['user-agent'] || '').slice(0, 200), c.id]);
    if (!u.rowCount) return res.status(409).json({ error: 'Bu onam zaten imzalanmış ya da süresi dolmuş.' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Bir hata oluştu.' }); }
});
module.exports = router;
module.exports.validPng = validPng;
