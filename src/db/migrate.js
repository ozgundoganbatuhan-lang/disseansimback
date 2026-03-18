'use strict';
const { pool } = require('./index');

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
      CREATE EXTENSION IF NOT EXISTS pg_trgm;
    `);

    // ── TENANTS ──────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS tenants (
        id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        slug                  TEXT UNIQUE NOT NULL,
        name                  TEXT NOT NULL,
        plan                  TEXT NOT NULL DEFAULT 'trial',
        plan_status           TEXT NOT NULL DEFAULT 'active',
        trial_ends_at         TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '14 days',
        iyzico_customer_ref   TEXT,
        iyzico_card_token     TEXT,
        iyzico_subscription_ref TEXT,
        next_billing_date     DATE,
        max_users             INT NOT NULL DEFAULT 2,
        max_patients          INT,
        max_branches          INT NOT NULL DEFAULT 1,
        ai_tokens_monthly     INT NOT NULL DEFAULT 50000,
        storage_gb            INT NOT NULL DEFAULT 5,
        settings              JSONB NOT NULL DEFAULT '{}',
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS branches (
        id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        name        TEXT NOT NULL,
        address     TEXT,
        phone       TEXT,
        is_main     BOOLEAN NOT NULL DEFAULT false,
        is_active   BOOLEAN NOT NULL DEFAULT true,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_branches_tenant ON branches(tenant_id);
    `);

    // ── USERS ────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        email             TEXT UNIQUE NOT NULL,
        password_hash     TEXT,
        name              TEXT NOT NULL,
        title             TEXT NOT NULL DEFAULT 'Dr.',
        speciality        TEXT NOT NULL DEFAULT 'Diş Hekimi',
        diploma_no        TEXT,
        phone             TEXT,
        avatar_url        TEXT,
        email_verified    BOOLEAN NOT NULL DEFAULT false,
        verify_token      TEXT,
        reset_token       TEXT,
        reset_token_exp   TIMESTAMPTZ,
        refresh_tokens    JSONB NOT NULL DEFAULT '[]',
        last_seen_at      TIMESTAMPTZ,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS memberships (
        id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        branch_id    UUID REFERENCES branches(id),
        role         TEXT NOT NULL DEFAULT 'dentist',
        status       TEXT NOT NULL DEFAULT 'active',
        invited_by   UUID REFERENCES users(id),
        joined_at    TIMESTAMPTZ,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(user_id, tenant_id)
      );
      CREATE INDEX IF NOT EXISTS idx_memberships_tenant ON memberships(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id);
    `);

    // ── PATIENTS ─────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS patients (
        id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        tenant_id          UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        branch_id          UUID REFERENCES branches(id),
        tc                 TEXT,
        first_name         TEXT NOT NULL,
        last_name          TEXT NOT NULL,
        birth_date         DATE,
        gender             TEXT,
        phone              TEXT,
        email              TEXT,
        address            TEXT,
        blood_type         TEXT,
        allergies          TEXT[],
        systemic_diseases  TEXT[],
        medications        TEXT[],
        insurance          TEXT,
        insurance_no       TEXT,
        emergency_name     TEXT,
        emergency_phone    TEXT,
        tags               TEXT[],
        referral_source    TEXT,
        notes              TEXT,
        gdpr_consented_at  TIMESTAMPTZ,
        gdpr_ip            TEXT,
        is_active          BOOLEAN NOT NULL DEFAULT true,
        created_by         UUID REFERENCES users(id),
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at         TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_patients_tenant ON patients(tenant_id) WHERE deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_patients_trgm ON patients
        USING gin((first_name || ' ' || last_name || ' ' || COALESCE(phone,'') || ' ' || COALESCE(tc,'')) gin_trgm_ops);
    `);

    // ── CHAIRS / UNITS ────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS chairs (
        id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        branch_id  UUID REFERENCES branches(id),
        name       TEXT NOT NULL,
        color      TEXT NOT NULL DEFAULT '#219EAD',
        is_active  BOOLEAN NOT NULL DEFAULT true
      );
    `);

    // ── APPOINTMENTS ──────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS appointments (
        id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        branch_id       UUID REFERENCES branches(id),
        patient_id      UUID NOT NULL REFERENCES patients(id),
        doctor_id       UUID NOT NULL REFERENCES users(id),
        chair_id        UUID REFERENCES chairs(id),
        plan_id         UUID,
        starts_at       TIMESTAMPTZ NOT NULL,
        ends_at         TIMESTAMPTZ NOT NULL,
        type            TEXT NOT NULL DEFAULT 'Muayene',
        status          TEXT NOT NULL DEFAULT 'scheduled',
        tooth_numbers   INT[],
        notes           TEXT,
        reminder_sent   BOOLEAN NOT NULL DEFAULT false,
        no_show_reason  TEXT,
        created_by      UUID REFERENCES users(id),
        cancelled_at    TIMESTAMPTZ,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_apts_tenant_starts ON appointments(tenant_id, starts_at)
        WHERE status NOT IN ('cancelled');
      CREATE INDEX IF NOT EXISTS idx_apts_doctor ON appointments(doctor_id, starts_at);
      CREATE INDEX IF NOT EXISTS idx_apts_patient ON appointments(patient_id);
    `);

    // ── ODONTOGRAM ────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS teeth_records (
        id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        patient_id  UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
        tenant_id   UUID NOT NULL REFERENCES tenants(id),
        tooth_no    INT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'healthy',
        surfaces    TEXT[],
        notes       TEXT,
        recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        recorded_by UUID REFERENCES users(id),
        UNIQUE(patient_id, tooth_no)
      );
      CREATE INDEX IF NOT EXISTS idx_teeth_patient ON teeth_records(patient_id);
    `);

    // ── TREATMENT PLANS ───────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS treatment_plans (
        id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        patient_id       UUID NOT NULL REFERENCES patients(id),
        created_by       UUID REFERENCES users(id),
        title            TEXT NOT NULL,
        status           TEXT NOT NULL DEFAULT 'planned',
        tooth_numbers    INT[],
        diagnosis        TEXT,
        icd_code         TEXT,
        priority         TEXT NOT NULL DEFAULT 'normal',
        notes            TEXT,
        est_cost         NUMERIC(12,2),
        est_sessions     INT DEFAULT 1,
        patient_ok_at    TIMESTAMPTZ,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_plans_tenant ON treatment_plans(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_plans_patient ON treatment_plans(patient_id);
    `);

    // ── TREATMENT NOTES ───────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS treatment_notes (
        id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        patient_id      UUID NOT NULL REFERENCES patients(id),
        appointment_id  UUID REFERENCES appointments(id),
        plan_id         UUID REFERENCES treatment_plans(id),
        doctor_id       UUID NOT NULL REFERENCES users(id),
        tooth_numbers   INT[],
        session_date    DATE NOT NULL DEFAULT CURRENT_DATE,
        procedure       TEXT NOT NULL,
        anesthesia      TEXT,
        materials       TEXT,
        findings        TEXT,
        next_steps      TEXT,
        duration_mins   INT,
        ai_summary      TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_notes_patient ON treatment_notes(patient_id);
      CREATE INDEX IF NOT EXISTS idx_notes_tenant ON treatment_notes(tenant_id);
    `);

    // ── PRESCRIPTIONS ─────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS prescriptions (
        id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        patient_id     UUID NOT NULL REFERENCES patients(id),
        doctor_id      UUID NOT NULL REFERENCES users(id),
        appointment_id UUID REFERENCES appointments(id),
        rx_date        DATE NOT NULL DEFAULT CURRENT_DATE,
        diagnosis      TEXT,
        icd_code       TEXT,
        drugs          JSONB NOT NULL DEFAULT '[]',
        notes          TEXT,
        printed_at     TIMESTAMPTZ,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_rx_patient ON prescriptions(patient_id);
      CREATE INDEX IF NOT EXISTS idx_rx_tenant ON prescriptions(tenant_id);
    `);

    // ── X-RAYS ────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS xrays (
        id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        patient_id     UUID NOT NULL REFERENCES patients(id),
        doctor_id      UUID REFERENCES users(id),
        appointment_id UUID REFERENCES appointments(id),
        taken_date     DATE NOT NULL DEFAULT CURRENT_DATE,
        type           TEXT NOT NULL,
        tooth_numbers  INT[],
        file_url       TEXT,
        findings       TEXT,
        ai_analysis    TEXT,
        notes          TEXT,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_xrays_patient ON xrays(patient_id);
    `);

    // ── STERILIZATION ────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS sterilization_logs (
        id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
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
        test_result    TEXT NOT NULL DEFAULT 'pass',
        operator_id    UUID REFERENCES users(id),
        notes          TEXT,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_steril_tenant ON sterilization_logs(tenant_id, log_date DESC);
    `);

    // ── INVENTORY ────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS suppliers (
        id        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        name      TEXT NOT NULL,
        contact   TEXT,
        phone     TEXT,
        email     TEXT,
        address   TEXT,
        notes     TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS inventory_items (
        id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        branch_id    UUID REFERENCES branches(id),
        supplier_id  UUID REFERENCES suppliers(id),
        name         TEXT NOT NULL,
        sku          TEXT,
        category     TEXT,
        unit         TEXT NOT NULL DEFAULT 'adet',
        stock_qty    NUMERIC(12,3) NOT NULL DEFAULT 0,
        min_qty      NUMERIC(12,3) NOT NULL DEFAULT 5,
        unit_cost    NUMERIC(12,2),
        expiry_date  DATE,
        notes        TEXT,
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_inv_tenant ON inventory_items(tenant_id);
    `);

    // ── INVOICES & PAYMENTS ───────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS invoices (
        id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        branch_id        UUID REFERENCES branches(id),
        patient_id       UUID NOT NULL REFERENCES patients(id),
        appointment_id   UUID REFERENCES appointments(id),
        inv_no           TEXT NOT NULL,
        inv_date         DATE NOT NULL DEFAULT CURRENT_DATE,
        due_date         DATE,
        status           TEXT NOT NULL DEFAULT 'draft',
        items            JSONB NOT NULL DEFAULT '[]',
        subtotal         NUMERIC(12,2) NOT NULL DEFAULT 0,
        discount_amount  NUMERIC(12,2) NOT NULL DEFAULT 0,
        tax_rate         NUMERIC(5,2) NOT NULL DEFAULT 0,
        tax_amount       NUMERIC(12,2) NOT NULL DEFAULT 0,
        total            NUMERIC(12,2) NOT NULL DEFAULT 0,
        amount_paid      NUMERIC(12,2) NOT NULL DEFAULT 0,
        notes            TEXT,
        created_by       UUID REFERENCES users(id),
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_inv_tenant ON invoices(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_inv_patient ON invoices(patient_id);

      CREATE TABLE IF NOT EXISTS payments (
        id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        tenant_id    UUID NOT NULL REFERENCES tenants(id),
        invoice_id   UUID NOT NULL REFERENCES invoices(id),
        amount       NUMERIC(12,2) NOT NULL,
        method       TEXT NOT NULL DEFAULT 'nakit',
        paid_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        reference    TEXT,
        notes        TEXT,
        recorded_by  UUID REFERENCES users(id),
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // ── SUBSCRIPTION PAYMENTS (iyzico) ────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS subscription_payments (
        id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        tenant_id           UUID NOT NULL REFERENCES tenants(id),
        iyzico_payment_id   TEXT,
        iyzico_token        TEXT,
        amount              NUMERIC(10,2) NOT NULL,
        currency            TEXT NOT NULL DEFAULT 'TRY',
        plan                TEXT NOT NULL,
        period              TEXT NOT NULL DEFAULT 'monthly',
        status              TEXT NOT NULL DEFAULT 'pending',
        error_code          TEXT,
        error_message       TEXT,
        paid_at             TIMESTAMPTZ,
        period_start        DATE,
        period_end          DATE,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_subpay_tenant ON subscription_payments(tenant_id);
    `);

    // ── AUDIT LOG ────────────────────────────────────────────────────────
    await client.query(`
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
        user_agent   TEXT,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_audit_tenant ON audit_logs(tenant_id, created_at DESC);
    `);

    // ── NOTIFICATIONS ────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id          BIGSERIAL PRIMARY KEY,
        tenant_id   UUID NOT NULL REFERENCES tenants(id),
        user_id     UUID REFERENCES users(id),
        patient_id  UUID REFERENCES patients(id),
        type        TEXT NOT NULL,
        title       TEXT NOT NULL,
        body        TEXT,
        channel     TEXT NOT NULL DEFAULT 'in_app',
        status      TEXT NOT NULL DEFAULT 'pending',
        payload     JSONB NOT NULL DEFAULT '{}',
        sent_at     TIMESTAMPTZ,
        read_at     TIMESTAMPTZ,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read_at NULLS FIRST);
    `);

    // ── SUBSCRIPTION PLANS (static data) ─────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS subscription_plans (
        id             TEXT PRIMARY KEY,
        name           TEXT NOT NULL,
        price_monthly  NUMERIC(8,2),
        price_annual   NUMERIC(8,2),
        max_users      INT,
        max_branches   INT,
        max_patients   INT,
        ai_tokens_mo   INT,
        storage_gb     INT,
        features       JSONB NOT NULL DEFAULT '[]'
      );
      INSERT INTO subscription_plans VALUES
        ('trial',      'Ücretsiz Deneme', 0,     0,      2,    1,  200,    10000,   1,  '["odontogram","prescriptions","sterilization","appointments","patients"]')
        ON CONFLICT DO NOTHING;
      INSERT INTO subscription_plans VALUES
        ('starter',    'Solo Hekim',     590,   5900,   2,    1,  2000,   50000,   5,  '["odontogram","prescriptions","sterilization","appointments","patients","billing","inventory","xrays","reports_basic"]')
        ON CONFLICT DO NOTHING;
      INSERT INTO subscription_plans VALUES
        ('growth',     'Klinik',        1190,  11900,  8,    3,  NULL,   200000,  20, '["all_starter","multi_branch","multi_doctor","api_access","reports_advanced","team_management","ai_notes"]')
        ON CONFLICT DO NOTHING;
      INSERT INTO subscription_plans VALUES
        ('enterprise', 'Poliklinik',    NULL,  NULL,   NULL, NULL, NULL, NULL,    NULL,'["all_growth","sso","custom_domain","sla","dedicated_support","white_label"]')
        ON CONFLICT DO NOTHING;
    `);

    // ── Safe ALTER TABLE — idempotent ────────────────────────────────────
    const safeAlters = [
      `ALTER TABLE xrays ADD COLUMN IF NOT EXISTS image_data TEXT`,
      `ALTER TABLE xrays ADD COLUMN IF NOT EXISTS file_mime TEXT`,
      `ALTER TABLE teeth_records ADD COLUMN IF NOT EXISTS mobility SMALLINT NOT NULL DEFAULT 0`,


      // v8 schema additions
      `ALTER TABLE xrays ADD COLUMN IF NOT EXISTS image_data TEXT`,
      `ALTER TABLE teeth_records ADD COLUMN IF NOT EXISTS mobility SMALLINT NOT NULL DEFAULT 0`,

      `ALTER TABLE appointments ADD COLUMN IF NOT EXISTS email_reminder_sent BOOLEAN NOT NULL DEFAULT false`,
      `ALTER TABLE appointments ADD COLUMN IF NOT EXISTS no_show BOOLEAN NOT NULL DEFAULT false`,
      `ALTER TABLE treatment_plans ADD COLUMN IF NOT EXISTS patient_ok_at TIMESTAMPTZ`,
      `ALTER TABLE treatment_plans ADD COLUMN IF NOT EXISTS patient_ok_ip TEXT`,
      `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS inv_no TEXT`,
      `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS inv_date DATE DEFAULT CURRENT_DATE`,
      `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(12,2) DEFAULT 0`,
      `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS tax_rate NUMERIC(5,2) DEFAULT 0`,
      `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS items JSONB DEFAULT '[]'`,
      `ALTER TABLE notifications ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'in_app'`,
      `ALTER TABLE notifications ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ`,
    ];
    for (const sql of safeAlters) {
      await client.query(sql).catch(e => console.warn('ALTER skip:', e.message));
    }
    await client.query(`CREATE SEQUENCE IF NOT EXISTS inv_seq START 1`).catch(()=>{});

    await client.query('COMMIT');
    console.log('✅ Migration tamamlandı (v8).');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Migration hatası:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

// Direkt çalıştırılırsa (node src/db/migrate.js) hemen çalış
// require() ile çağrılırsa sadece fonksiyonu export et
if (require.main === module) {
  migrate().then(() => process.exit(0)).catch(() => process.exit(1));
}

module.exports = { migrate };
