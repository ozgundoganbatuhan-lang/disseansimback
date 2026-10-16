'use strict';
require('dotenv').config();

const required = ['DATABASE_URL','JWT_SECRET'];
for (const k of required) { if (!process.env[k]) { console.error('HATA: '+k+' tanimli degil'); process.exit(1); } }

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const app = express();

app.use(helmet({ contentSecurityPolicy: false }));
app.set('trust proxy', 1);

// CORS — OPTIONS preflight'a her zaman 200 dön
app.options('*', cors());
app.use(cors({
  origin: function(origin, cb) {
    // origin yoksa (curl, Postman, server-to-server) izin ver
    if (!origin) return cb(null, true);
    const raw = process.env.CORS_ORIGINS || '*';
    const allowed = raw.split(',').map(s => s.trim());
    if (allowed.includes('*') || allowed.includes(origin)) return cb(null, true);
    console.warn('CORS blocked:', origin, '| allowed:', allowed);
    cb(new Error('CORS not allowed: ' + origin));
  },
  credentials: true,
  methods: ['GET','POST','PUT','DELETE','PATCH','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','X-Tenant-ID','X-Portal-Token'],
  exposedHeaders: ['Content-Range','X-Total-Count'],
}));

app.use(compression());
// Hasta imza sayfası: giriş gerektirmez, küçük gövde sınırı (genel 50 MB sınırından önce bağlanır)
app.use('/api/public', rateLimit({ windowMs: 15 * 60 * 1000, max: 60 }), express.json({ limit: '600kb' }), require('./routes/publicConsent'));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));
// İmza linkindeki token loglara yazılmasın
morgan.token('safe-url', (req) => (req.originalUrl || req.url).replace(/(\/api\/public\/onam\/)[^/?]+/, '$1***'));
app.use(morgan(process.env.NODE_ENV === 'production' ? ':remote-addr - :remote-user [:date[clf]] ":method :safe-url HTTP/:http-version" :status :res[content-length] ":referrer" ":user-agent"' : ':method :safe-url :status :response-time ms'));

const limiter = rateLimit({
  windowMs:15*60*1000,
  max:parseInt(process.env.RATE_LIMIT_MAX)||1000,
  message:{error:'Cok fazla istek.'},
  standardHeaders:true, legacyHeaders:false,
  skip:r=>r.path==='/health',
  // IP bazlı: JWT başlığı herkes için aynı olduğundan token önekiyle anahtar üretmek tüm kullanıcıları tek kovaya koyuyordu
  keyGenerator:r=>r.ip
});
const authLimiter = rateLimit({ windowMs:15*60*1000, max:50, message:{error:'Cok fazla giris denemesi.'} });
app.use(limiter);

// Migration — sunucu başlarken otomatik çalıştır
const { migrate } = require('./db/migrate');
migrate()
  .then(() => console.log('Migration OK'))
  .catch(e => console.error('Migration hatasi (devam ediliyor):', e.message));

const { pool } = require('./db');
pool.query('SELECT 1').then(() => console.log('PostgreSQL OK')).catch(err => console.error('PostgreSQL ERR:', err.message));

if (process.env.ENABLE_SCHEDULER !== 'false') {
  try { require('./services/scheduler').startScheduler(); } catch(e) { console.warn('Scheduler hatasi:', e.message); }
}

app.get('/health', (req, res) => res.json({ status:'ok', service:'DisSeansim Backend', version:'12.0.0',build:'2026-03-19T00:05:01Z', ts:new Date().toISOString() }));

app.use('/api/auth', authLimiter, require('./routes/auth'));
app.use('/api/subscriptions', require('./routes/subscriptions'));
app.use('/api/patients', require('./routes/patients'));
app.use('/api/portal', require('./routes/portal'));
app.use('/api/sms', require('./routes/sms'));
app.use('/api/email', require('./routes/email'));
app.use('/api/ai', require('./routes/ai'));
app.use('/api/referral', require('./routes/referral'));
app.use('/api/analytics', require('./routes/analytics'));
app.use('/api/team', require('./routes/team'));
app.use('/api/pdf', require('./routes/pdf'));
app.use('/api/clinic', require('./routes/clinic'));
app.use('/api', require('./routes/api'));

app.use((req, res) => res.status(404).json({ error:'Endpoint bulunamadi: '+req.method+' '+req.path }));
app.use((err, req, res, next) => {
  console.error('Server error:', err.message);
  res.status(err.status||500).json({ error: process.env.NODE_ENV==='production' && !err.status ? 'Sunucu hatasi' : err.message });
});

const PORT = parseInt(process.env.PORT) || 3001;
app.listen(PORT, '0.0.0.0', () => console.log('DisSeansim Backend v12.0 [2026-03-18T23:49:18Z] :' + PORT));
module.exports = app;
