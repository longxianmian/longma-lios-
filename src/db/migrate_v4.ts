import { pool } from './client';

const DDL_V4 = `
-- ═══════════════════════════════════════════════════════════════
-- LIOS  Schema V4 — Tenant Auth
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS lios_tenants (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT NOT NULL UNIQUE,
  company_name  TEXT NOT NULL,
  contact_name  TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  industry      TEXT NOT NULL DEFAULT '',
  company_size  TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','disabled')),
  token         TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lios_tenants_email     ON lios_tenants(email);
CREATE INDEX IF NOT EXISTS idx_lios_tenants_tenant_id ON lios_tenants(tenant_id);
CREATE INDEX IF NOT EXISTS idx_lios_tenants_status    ON lios_tenants(status);
`;

async function migrateV4() {
  const client = await pool.connect();
  try {
    console.log('[migrate-v4] Applying V4: Tenant Auth...');
    await client.query(DDL_V4);
    console.log('[migrate-v4] Done. New table: lios_tenants');
  } catch (err) {
    console.error('[migrate-v4] Failed:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrateV4();
