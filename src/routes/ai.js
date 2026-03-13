'use strict';
const router = require('express').Router();
const { authMiddleware, tenantMiddleware } = require('../middleware/auth');
const { query } = require('../db');

router.use(authMiddleware, tenantMiddleware);

// AI Note Assist — seans notundan klinik SOAP notu üret
router.post('/note-assist', async (req, res) => {
  try {
    const { keywords, patient, tooth_numbers, procedure } = req.body;
    if (!keywords) return res.status(400).json({ error: 'Anahtar kelimeler gerekli' });

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(503).json({ error: 'AI servisi yapılandırılmamış' });

    // Check plan — AI only for growth+
    const plan = req.membership && req.membership.plan;
    if (!['growth','enterprise'].includes(plan)) {
      return res.status(402).json({ error: 'AI Not Asistanı Klinik planında mevcut.', upgrade: true });
    }

    const systemPrompt = `Sen bir diş hekimi klinik not asistanısın. Türkçe, kısa ve klinik SOAP formatında notlar yazarsın.
Sadece not metnini yaz, başlık veya açıklama ekleme.
Format: S (Subjektif) → O (Objektif) → A (Değerlendirme) → P (Plan)
Her bölüm en fazla 1-2 cümle. Toplam 80-120 kelime.`;

    const userPrompt = `Hasta: ${patient || 'Anonim'}
Diş: ${tooth_numbers ? tooth_numbers.join(', ') : 'belirtilmedi'}
İşlem: ${procedure || ''}
Anahtar notlar: ${keywords}

Bu bilgilerden klinik SOAP notu üret.`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      })
    });

    if (!response.ok) throw new Error('AI API hatası: ' + response.status);
    const data = await response.json();
    const text = data.content && data.content[0] && data.content[0].text;
    if (!text) throw new Error('AI yanıt boş döndü');

    // Log usage
    await query('INSERT INTO audit_logs (tenant_id, user_id, action, entity_type) VALUES ($1,$2,$3,$4)', [req.tenantId, req.user.id, 'ai.note_assist', 'ai']).catch(()=>{});

    res.json({ note: text });
  } catch (err) {
    console.error('AI note assist:', err.message);
    res.status(500).json({ error: 'AI servisi şu an yanıt vermiyor. Lütfen tekrar deneyin.' });
  }
});

// AI Prescription Suggest — teşhise göre ilaç öner
router.post('/rx-suggest', async (req, res) => {
  try {
    const { diagnosis, allergies } = req.body;
    if (!diagnosis) return res.status(400).json({ error: 'Teşhis gerekli' });

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(503).json({ error: 'AI servisi yapılandırılmamış' });

    const plan = req.membership && req.membership.plan;
    if (!['growth','enterprise'].includes(plan)) {
      return res.status(402).json({ error: 'AI önerisi Klinik planında mevcut.', upgrade: true });
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        system: 'Diş hekimliği reçete asistanısın. Sadece JSON dön: [{"name":"...","dose":"...","frequency":"...","duration":"..."}]. Maksimum 3 ilaç. Alerji varsa alternatif öner.',
        messages: [{ role: 'user', content: 'Teşhis: ' + diagnosis + (allergies ? '\nAlerjiler: ' + allergies : '') }]
      })
    });

    const data = await response.json();
    let drugs = [];
    try {
      const text = data.content[0].text.replace(/```json|```/g,'').trim();
      drugs = JSON.parse(text);
    } catch(e) { drugs = []; }

    res.json({ drugs });
  } catch (err) {
    res.status(500).json({ error: 'AI servisi yanıt vermedi.' });
  }
});

module.exports = router;
