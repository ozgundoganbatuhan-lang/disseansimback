// src/db/database.js
const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');

const DB_PATH = process.env.DB_PATH || '/data/terapiseansim.db';
const dir = path.dirname(DB_PATH);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout  = 5000');

// ── ŞEMA ─────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id                  TEXT PRIMARY KEY,
    email               TEXT UNIQUE NOT NULL,
    password            TEXT NOT NULL,
    name                TEXT NOT NULL,
    clinic_name         TEXT DEFAULT '',
    clinic_addr         TEXT DEFAULT '',
    clinic_phone        TEXT DEFAULT '',
    therapies           TEXT DEFAULT '["BDT","PSI","EMDR","SCHEMA","ÇİFT","GRUP","İLK","ONLİNE"]',
    prices              TEXT DEFAULT '{}',
    settings            TEXT DEFAULT '{}',
    gcal_tokens         TEXT DEFAULT NULL,
    gcal_id             TEXT DEFAULT NULL,
    inv_counter         INTEGER DEFAULT 1,
    plan                TEXT DEFAULT 'trial',
    trial_ends          TEXT DEFAULT NULL,
    trial_warning_sent  INTEGER DEFAULT 0,
    terms_accepted_at   TEXT DEFAULT NULL,
    terms_version       TEXT DEFAULT NULL,
    kvkk_accepted_at    TEXT DEFAULT NULL,
    ip_at_acceptance    TEXT DEFAULT '',
    reset_token         TEXT DEFAULT NULL,
    reset_token_expires TEXT DEFAULT NULL,
    created_at          TEXT DEFAULT (datetime('now')),
    updated_at          TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS patients (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    first_name  TEXT NOT NULL,
    last_name   TEXT NOT NULL,
    dob         TEXT,
    gender      TEXT DEFAULT 'F',
    phone       TEXT,
    email       TEXT,
    complaint   TEXT,
    therapy     TEXT DEFAULT 'BDT',
    price       REAL DEFAULT 0,
    insurance   TEXT DEFAULT 'none',
    emergency   TEXT,
    color       TEXT DEFAULT '#7C6FAE',
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS appointments (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    patient_id    TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    therapy       TEXT DEFAULT 'BDT',
    at_time       TEXT NOT NULL,
    duration      INTEGER DEFAULT 50,
    status        TEXT DEFAULT 'SCHEDULED',
    medium        TEXT DEFAULT 'face',
    note          TEXT DEFAULT '',
    gcal_event_id TEXT DEFAULT NULL,
    created_at    TEXT DEFAULT (datetime('now')),
    updated_at    TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS session_notes (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    patient_id  TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    session_no  INTEGER NOT NULL,
    date        TEXT NOT NULL,
    therapy     TEXT DEFAULT 'BDT',
    content_enc TEXT NOT NULL,
    mood        TEXT DEFAULT 'neutral',
    homework    TEXT DEFAULT '',
    duration    INTEGER DEFAULT 50,
    created_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS scores (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    patient_id  TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    scale       TEXT NOT NULL,
    score       INTEGER NOT NULL,
    answers     TEXT DEFAULT '[]',
    date        TEXT NOT NULL,
    created_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS packages (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    patient_id   TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    name         TEXT DEFAULT '',
    sessions     INTEGER NOT NULL,
    used         INTEGER DEFAULT 0,
    price        REAL DEFAULT 0,
    start_date   TEXT,
    payment_note TEXT DEFAULT '',
    created_at   TEXT DEFAULT (datetime('now')),
    updated_at   TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS invoices (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    patient_id  TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    number      TEXT NOT NULL,
    service     TEXT DEFAULT 'Terapi Seansı',
    amount      REAL NOT NULL,
    tax_rate    REAL DEFAULT 0,
    method      TEXT DEFAULT 'cash',
    status      TEXT DEFAULT 'PAID',
    date        TEXT NOT NULL,
    note        TEXT DEFAULT '',
    created_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    action      TEXT NOT NULL,
    ip          TEXT DEFAULT '',
    created_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_pat_user   ON patients(user_id);
  CREATE INDEX IF NOT EXISTS idx_apt_user   ON appointments(user_id);
  CREATE INDEX IF NOT EXISTS idx_apt_time   ON appointments(at_time);
  CREATE INDEX IF NOT EXISTS idx_apt_pat    ON appointments(patient_id);
  CREATE INDEX IF NOT EXISTS idx_notes_pat  ON session_notes(patient_id);
  CREATE INDEX IF NOT EXISTS idx_scores_pat ON scores(patient_id);
  CREATE INDEX IF NOT EXISTS idx_inv_user   ON invoices(user_id);
  CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id);
`);

// ── GEÇİŞ MİGRASYONLARI (mevcut DB'ler için ALTER TABLE) ──
// CREATE IF NOT EXISTS üst şemayı yapar, ALTER mevcut eksikleri tamamlar
const migrations = [
  // users — yeni kolonlar
  "ALTER TABLE users ADD COLUMN settings TEXT DEFAULT '{}'",
  "ALTER TABLE users ADD COLUMN terms_accepted_at TEXT",
  "ALTER TABLE users ADD COLUMN terms_version TEXT",
  "ALTER TABLE users ADD COLUMN kvkk_accepted_at TEXT",
  "ALTER TABLE users ADD COLUMN ip_at_acceptance TEXT DEFAULT ''",
  "ALTER TABLE users ADD COLUMN reset_token TEXT",
  "ALTER TABLE users ADD COLUMN reset_token_expires TEXT",
  "ALTER TABLE users ADD COLUMN trial_warning_sent INTEGER DEFAULT 0",
  // patients — yeni kolonlar
  "ALTER TABLE patients ADD COLUMN price REAL DEFAULT 0",
  "ALTER TABLE patients ADD COLUMN insurance TEXT DEFAULT 'none'",
  // scores — answers kolonu
  "ALTER TABLE scores ADD COLUMN answers TEXT DEFAULT '[]'",
  // packages — name ve price
  "ALTER TABLE packages ADD COLUMN name TEXT DEFAULT ''",
  "ALTER TABLE packages ADD COLUMN price REAL DEFAULT 0",
  // invoices — tax_rate
  "ALTER TABLE invoices ADD COLUMN tax_rate REAL DEFAULT 0",
  // appointments — medium
  "ALTER TABLE appointments ADD COLUMN medium TEXT DEFAULT 'face'",
  // appointments — hatirlatici alanlar
  "ALTER TABLE appointments ADD COLUMN email_reminder INTEGER DEFAULT 0",
  "ALTER TABLE appointments ADD COLUMN email_reminder_min INTEGER DEFAULT 1440",
  "ALTER TABLE appointments ADD COLUMN sms_reminder INTEGER DEFAULT 0",
  "ALTER TABLE appointments ADD COLUMN sms_reminder_min INTEGER DEFAULT 120",
  // users — telefon ve e-posta dogrulama
  "ALTER TABLE users ADD COLUMN phone TEXT DEFAULT ''",
  "ALTER TABLE users ADD COLUMN email_verified INTEGER DEFAULT 0",
  "ALTER TABLE users ADD COLUMN email_verify_token TEXT DEFAULT NULL",
  "ALTER TABLE users ADD COLUMN email_verify_expires TEXT DEFAULT NULL",
];

for (const sql of migrations) {
  try { db.exec(sql); } catch(_) {}  // kolон zaten varsa sessizce geç
}

// Mevcut kullanicilari dogrulanmis say (geriye donuk uyumluluk)
try {
  db.exec("UPDATE users SET email_verified=1 WHERE email_verified=0 AND created_at < datetime('now','-1 second')");
} catch(_) {}

module.exports = db;
