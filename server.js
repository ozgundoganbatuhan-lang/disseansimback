// server.js — TerapiSeansım SaaS Backend v2.0
require('dotenv').config();

const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');

const app  = express();
const PORT = process.env.PORT || 4000;

// ── GÜVENLİK ─────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.set('trust proxy', 1);

const rawOrigins = (process.env.CORS_ORIGIN || '*').split(',').map(s => s.trim());
const allowAll = rawOrigins.includes('*');
// Vercel preview URL'leri için wildcard
const vercelPattern = /^https:\/\/[\w-]+-[\w-]+\.vercel\.app$/;
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // Postman / curl / same-origin
    if (allowAll) return cb(null, true); // CORS_ORIGIN=* (geliştirme)
    if (rawOrigins.includes(origin)) return cb(null, true);
    if (vercelPattern.test(origin)) return cb(null, true);
    console.warn('[CORS] Reddedildi:', origin, '| İzinli:', rawOrigins);
    cb(new Error('CORS: İzin verilmeyen origin: ' + origin));
  },
  credentials: true,
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
}));

// Global rate limit
app.use('/api/', rateLimit({
  windowMs: 60_000, max: parseInt(process.env.RATE_LIMIT_MAX) || 120,
  message: { error: 'Çok fazla istek. Lütfen 1 dakika bekleyin.' },
  standardHeaders: true, legacyHeaders: false,
}));

// Auth için sıkı limit
app.use('/api/auth/', rateLimit({
  windowMs: 15 * 60_000, max: 20,
  message: { error: 'Çok fazla giriş denemesi. 15 dakika bekleyin.' },
}));

// AI endpoint — biraz daha cömert (istek başına ~1-2sn sürer)
app.use('/api/ai/', rateLimit({
  windowMs: 60_000, max: 30,
  message: { error: 'AI istekleri dakikada 30 ile sınırlıdır.' },
}));

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// ── REQUEST LOG (development) ─────────────────────────────────
if (process.env.NODE_ENV !== 'production') {
  app.use((req, _res, next) => {
    console.log(`${new Date().toISOString().slice(11,19)} ${req.method} ${req.path}`);
    next();
  });
}

// ── ROUTES ────────────────────────────────────────────────────
app.use('/api/auth',         require('./src/routes/auth'));
app.use('/api/patients',     require('./src/routes/patients'));
app.use('/api/appointments', require('./src/routes/appointments'));
app.use('/api/notes',        require('./src/routes/notes'));
app.use('/api/scores',       require('./src/routes/scores'));
app.use('/api/packages',     require('./src/routes/packages'));
app.use('/api/invoices',     require('./src/routes/invoices'));
app.use('/api/settings',     require('./src/routes/settings'));
app.use('/api/ai',           require('./src/routes/ai'));
app.use('/api/calendar',     require('./src/routes/calendar'));

// ── HEALTH ────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({
  status: 'ok', app: 'TerapiSeansım API v2',
  ts: new Date().toISOString(), uptime: Math.floor(process.uptime()) + 's',
  features: {
    ai:   !!process.env.ANTHROPIC_API_KEY,
    gcal: !!process.env.GOOGLE_CLIENT_ID,
  }
}));

// ── 404 & ERROR ───────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: `${req.method} ${req.path} bulunamadı.` }));
app.use((err, _req, res, _next) => {
  if (err.message?.startsWith('CORS')) return res.status(403).json({ error: err.message });
  console.error('[ERROR]', err.message);
  res.status(500).json({ error: 'Sunucu hatası.' });
});

// ── START ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  const line = '═'.repeat(48);
  console.log(`\n╔${line}╗`);
  console.log(`║  🌿 TerapiSeansım API v2.0 — Başlatıldı        ║`);
  console.log(`║  🔗 http://localhost:${PORT}${' '.repeat(26)}║`);
  console.log(`║  📊 /health   🤖 AI: ${process.env.ANTHROPIC_API_KEY?'✅':'❌ .env gerekli'}${' '.repeat(process.env.ANTHROPIC_API_KEY?13:6)}║`);
  console.log(`║  📅 GCal: ${process.env.GOOGLE_CLIENT_ID?'✅ Bağlı':'❌ .env gerekli'}${' '.repeat(process.env.GOOGLE_CLIENT_ID?17:10)}║`);
  console.log(`║  📧 Email: ${process.env.RESEND_API_KEY?'✅ Resend':'⚠️  RESEND_API_KEY yok'}      ║`);
  console.log(`╚${line}╝\n`);
  // Trial uyarı cron'u
  try { const { startTrialCron } = require('./src/services/trialCron'); startTrialCron(); } catch(e) {}
});

module.exports = app;
