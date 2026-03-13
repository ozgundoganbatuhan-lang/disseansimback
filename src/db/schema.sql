-- DişSeansım v2 — Full SaaS PostgreSQL Schema
-- Run with: psql $DATABASE_URL -f schema.sql

-- Extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "unaccent";

-- ═══════════════════════════════════════════
-- SUBSCRIPTION PLANS (seed)
-- ═══════════════════════════════════════════
CREATE TABLE IF NOT EXISTS subscription_plans (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  price_monthly   NUMERIC(10,2),
  price_annual    NUMERIC(10,2),
  max_users       INT,
  max_branches    INT,
  ai_calls_month  INT DEFAULT 50,
  storage_gb      INT DEFAULT 5,
  features        JSONB DEFAULT '[]'
);

INSERT INTO subscription_plans (id,name,price_monthly,price_annual,max_users,max_branches,ai_calls_month,storage_gb,features) VALUES
  ('trial',      'Deneme',       0,      0,      3,   1,  20,   1,  '["core"]'),
  ('solo',       'Solo Hekim',   590,    5900,   2,   1,  100,  5,  '["core","reports"]'),
  ('klinik',     'Klinik',       1190,   11900,  8,   3,  300,  20, '["core","reports","multi_branch","api"]'),
  ('poliklinik', 'Poliklinik',   2390,   23900,  NULL,NULL,1000,100,'["all","sso","custom_domain","priority_support"]')
ON CONFLICT(id) DO NOTHING;

-- ═══════════════════════════════════════════
-- TENANTS (Klinikler)
-- ═══════════════════════════════════════════
CREATE TABLE IF NOT EXISTS tenants (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                  TEXT UNIQUE NOT NULL,
  name                  TEXT NOT NULL,
  plan_id               TEXT DEFAULT 'trial' REFERENCES subscription_plans(id),
  plan_status           TEXT DEFAULT 'active',
  trial_ends_at         TIMESTAMPTZ DEFAULT NOW() + INTERVAL '14 days',
  iyzico_subscription_id TEXT,
  iyzico_customer_ref   TEXT,
  billing_email         TEXT,
  billing_period        TEXT DEFAULT 'monthly',
  next_billing_at       TIMESTAMPTZ,
  settings              JSONB DEFAULT '{}',
  created_at            TIMESTAMPTZ DEFAULT NOW()
);

-- ═══════════════════════════════════════════
-- BRANCHES (Şubeler)
-- ═══════════════════════════════════════════
CREATE TABLE IF NOT EXISTS branches (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  address     TEXT,
  phone       TEXT,
  is_main     BOOLEAN DEFAULT false,
  is_active   BOOLEAN DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ═══════════════════════════════════════════
-- USERS
-- ═══════════════════════════════════════════
CREATE TABLE IF NOT EXISTS users (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email            TEXT UNIQUE NOT NULL,
  password_hash    TEXT,
  name             TEXT NOT NULL,
  title            TEXT DEFAULT 'Dr.',
  speciality       TEXT DEFAULT 'Diş Hekimi',
  diploma_no       TEXT,
  phone            TEXT,
  avatar_url       TEXT,
  email_verified   BOOLEAN DEFAULT false,
  verify_token     TEXT,
  reset_token      TEXT,
  reset_expires    TIMESTAMPTZ,
  two_fa_enabled   BOOLEAN DEFAULT false,
  two_fa_secret    TEXT,
  last_seen_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ═══════════════════════════════════════════
-- MEMBERSHIPS (User ↔ Tenant ilişkisi)
-- ═══════════════════════════════════════════
CREATE TABLE IF NOT EXISTS memberships (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id   UUID REFERENCES branches(id),
  role        TEXT NOT NULL DEFAULT 'dentist',
  status      TEXT DEFAULT 'active',
  invited_by  UUID REFERENCES users(id),
  joined_at   TIMESTAMPTZ DEFAULT NOW(),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, tenant_id)
);

CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_memberships_tenant ON memberships(tenant_id);

-- ═══════════════════════════════════════════
-- REFRESH TOKENS
-- ═══════════════════════════════════════════
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  device_info TEXT,
  ip_address  TEXT,
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ═══════════════════════════════════════════
-- CHAIRS (Ünit / Koltuklar)
-- ═══════════════════════════════════════════
CREATE TABLE IF NOT EXISTS chairs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id   UUID REFERENCES branches(id),
  name        TEXT NOT NULL,
  color       TEXT DEFAULT '#219EAD',
  is_active   BOOLEAN DEFAULT true
);

-- ═══════════════════════════════════════════
-- PATIENTS
-- ═══════════════════════════════════════════
CREATE TABLE IF NOT EXISTS patients (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id           UUID REFERENCES branches(id),
  tc                  TEXT,
  first_name          TEXT NOT NULL,
  last_name           TEXT NOT NULL,
  birth_date          DATE,
  gender              TEXT,
  phone               TEXT,
  email               TEXT,
  address             TEXT,
  blood_type          TEXT,
  allergies           TEXT,
  systemic_diseases   TEXT,
  medications         TEXT,
  insurance           TEXT,
  insurance_no        TEXT,
  emergency_name      TEXT,
  emergency_phone     TEXT,
  tags                TEXT[],
  referral_source     TEXT,
  gdpr_consented_at   TIMESTAMPTZ,
  notes               TEXT,
  is_active           BOOLEAN DEFAULT true,
  created_by          UUID REFERENCES users(id),
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW(),
  deleted_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_patients_tenant ON patients(tenant_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_patients_search ON patients(tenant_id, lower(first_name), lower(last_name));

-- ═══════════════════════════════════════════
-- APPOINTMENTS
-- ═══════════════════════════════════════════
CREATE TABLE IF NOT EXISTS appointments (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id        UUID REFERENCES branches(id),
  patient_id       UUID NOT NULL REFERENCES patients(id),
  doctor_id        UUID NOT NULL REFERENCES users(id),
  chair_id         UUID REFERENCES chairs(id),
  plan_id          UUID,
  starts_at        TIMESTAMPTZ NOT NULL,
  ends_at          TIMESTAMPTZ NOT NULL,
  type             TEXT NOT NULL DEFAULT 'Muayene',
  status           TEXT DEFAULT 'scheduled',
  tooth_numbers    TEXT,
  notes            TEXT,
  reminder_sent    BOOLEAN DEFAULT false,
  no_show          BOOLEAN DEFAULT false,
  cancelled_reason TEXT,
  created_by       UUID REFERENCES users(id),
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_apts_tenant_date ON appointments(tenant_id, starts_at) WHERE status != 'cancelled';
CREATE INDEX IF NOT EXISTS idx_apts_doctor ON appointments(doctor_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_apts_patient ON appointments(patient_id);

-- ═══════════════════════════════════════════
-- ODONTOGRAM
-- ═══════════════════════════════════════════
CREATE TABLE IF NOT EXISTS teeth_records (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id   UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  tenant_id    UUID NOT NULL REFERENCES tenants(id),
  tooth_no     INT NOT NULL,
  status       TEXT DEFAULT 'healthy',
  surfaces     TEXT,
  notes        TEXT,
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_by   UUID REFERENCES users(id),
  UNIQUE(patient_id, tooth_no)
);

-- ═══════════════════════════════════════════
-- TREATMENT PLANS
-- ═══════════════════════════════════════════
CREATE TABLE IF NOT EXISTS treatment_plans (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_id       UUID NOT NULL REFERENCES patients(id),
  created_by       UUID REFERENCES users(id),
  title            TEXT NOT NULL,
  status           TEXT DEFAULT 'draft',
  tooth_numbers    TEXT,
  diagnosis        TEXT,
  icd_code         TEXT,
  priority         TEXT DEFAULT 'normal',
  est_sessions     INT DEFAULT 1,
  notes            TEXT,
  approved_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS plan_items (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id      UUID NOT NULL REFERENCES treatment_plans(id) ON DELETE CASCADE,
  tenant_id    UUID NOT NULL REFERENCES tenants(id),
  tooth_number INT,
  procedure    TEXT NOT NULL,
  est_cost     NUMERIC(10,2),
  est_sessions INT DEFAULT 1,
  status       TEXT DEFAULT 'pending',
  completed_at TIMESTAMPTZ,
  sort_order   INT DEFAULT 0
);

-- ═══════════════════════════════════════════
-- TREATMENT NOTES
-- ═══════════════════════════════════════════
CREATE TABLE IF NOT EXISTS treatment_notes (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_id       UUID NOT NULL REFERENCES patients(id),
  appointment_id   UUID REFERENCES appointments(id),
  plan_id          UUID REFERENCES treatment_plans(id),
  doctor_id        UUID NOT NULL REFERENCES users(id),
  tooth_numbers    TEXT,
  session_date     DATE NOT NULL DEFAULT CURRENT_DATE,
  procedure        TEXT NOT NULL,
  anesthesia       TEXT,
  materials        TEXT,
  findings         TEXT,
  ai_summary       TEXT,
  next_steps       TEXT,
  duration_mins    INT,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ═══════════════════════════════════════════
-- PRESCRIPTIONS
-- ═══════════════════════════════════════════
CREATE TABLE IF NOT EXISTS prescriptions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_id       UUID NOT NULL REFERENCES patients(id),
  doctor_id        UUID NOT NULL REFERENCES users(id),
  appointment_id   UUID REFERENCES appointments(id),
  rx_date          DATE NOT NULL DEFAULT CURRENT_DATE,
  diagnosis        TEXT,
  icd_code         TEXT,
  drugs            JSONB NOT NULL DEFAULT '[]',
  notes            TEXT,
  printed_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ═══════════════════════════════════════════
-- X-RAYS
-- ═══════════════════════════════════════════
CREATE TABLE IF NOT EXISTS xrays (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_id       UUID NOT NULL REFERENCES patients(id),
  doctor_id        UUID REFERENCES users(id),
  appointment_id   UUID REFERENCES appointments(id),
  taken_date       DATE NOT NULL DEFAULT CURRENT_DATE,
  type             TEXT NOT NULL,
  tooth_numbers    TEXT,
  file_url         TEXT,
  findings         TEXT,
  ai_analysis      TEXT,
  notes            TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ═══════════════════════════════════════════
-- STERILIZATION LOG
-- ═══════════════════════════════════════════
CREATE TABLE IF NOT EXISTS sterilization_logs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id      UUID REFERENCES branches(id),
  log_date       DATE NOT NULL DEFAULT CURRENT_DATE,
  device_name    TEXT NOT NULL,
  device_serial  TEXT,
  cycle_no       TEXT,
  temperature    INT,
  pressure       NUMERIC(5,2),
  duration_min   INT,
  test_type      TEXT DEFAULT 'chemical',
  test_result    TEXT DEFAULT 'pass',
  operator_id    UUID REFERENCES users(id),
  notes          TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

-- ═══════════════════════════════════════════
-- BILLING
-- ═══════════════════════════════════════════
CREATE TABLE IF NOT EXISTS invoices (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id        UUID REFERENCES branches(id),
  patient_id       UUID NOT NULL REFERENCES patients(id),
  appointment_id   UUID REFERENCES appointments(id),
  inv_no           TEXT NOT NULL,
  inv_date         DATE NOT NULL DEFAULT CURRENT_DATE,
  due_date         DATE,
  status           TEXT DEFAULT 'draft',
  items            JSONB NOT NULL DEFAULT '[]',
  subtotal         NUMERIC(12,2) DEFAULT 0,
  discount_amount  NUMERIC(12,2) DEFAULT 0,
  tax_rate         NUMERIC(5,2) DEFAULT 0,
  tax_amount       NUMERIC(12,2) DEFAULT 0,
  total            NUMERIC(12,2) DEFAULT 0,
  amount_paid      NUMERIC(12,2) DEFAULT 0,
  notes            TEXT,
  created_by       UUID REFERENCES users(id),
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  invoice_id  UUID NOT NULL REFERENCES invoices(id),
  amount      NUMERIC(12,2) NOT NULL,
  method      TEXT NOT NULL DEFAULT 'nakit',
  reference   TEXT,
  paid_at     TIMESTAMPTZ DEFAULT NOW(),
  notes       TEXT,
  recorded_by UUID REFERENCES users(id)
);

-- ═══════════════════════════════════════════
-- INVENTORY
-- ═══════════════════════════════════════════
CREATE TABLE IF NOT EXISTS suppliers (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  contact     TEXT,
  phone       TEXT,
  email       TEXT,
  notes       TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS inventory_items (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id    UUID REFERENCES branches(id),
  supplier_id  UUID REFERENCES suppliers(id),
  name         TEXT NOT NULL,
  sku          TEXT,
  category     TEXT,
  unit         TEXT DEFAULT 'adet',
  stock_qty    NUMERIC(12,3) DEFAULT 0,
  min_qty      NUMERIC(12,3) DEFAULT 5,
  unit_cost    NUMERIC(12,2),
  expiry_date  DATE,
  notes        TEXT,
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ═══════════════════════════════════════════
-- AUDIT LOG
-- ═══════════════════════════════════════════
CREATE TABLE IF NOT EXISTS audit_logs (
  id           BIGSERIAL PRIMARY KEY,
  tenant_id    UUID REFERENCES tenants(id),
  user_id      UUID REFERENCES users(id),
  action       TEXT NOT NULL,
  entity_type  TEXT,
  entity_id    UUID,
  before_data  JSONB,
  after_data   JSONB,
  ip_address   TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_tenant ON audit_logs(tenant_id, created_at DESC);

-- ═══════════════════════════════════════════
-- NOTIFICATIONS
-- ═══════════════════════════════════════════
CREATE TABLE IF NOT EXISTS notifications (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  user_id     UUID REFERENCES users(id),
  type        TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT,
  link        TEXT,
  read_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ═══════════════════════════════════════════
-- AI USAGE
-- ═══════════════════════════════════════════
CREATE TABLE IF NOT EXISTS ai_usage (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  user_id       UUID REFERENCES users(id),
  feature       TEXT NOT NULL,
  model         TEXT,
  tokens_in     INT DEFAULT 0,
  tokens_out    INT DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
