import { pool } from './client';

const DDL_V3 = `
-- ═══════════════════════════════════════════════════════════════
-- LIOS  Schema V3 — Plugins + Assets + Multi-tenant
-- ═══════════════════════════════════════════════════════════════

-- 1. Plugin registry
CREATE TABLE IF NOT EXISTS lios_plugins (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    TEXT NOT NULL,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  plugin_type  TEXT NOT NULL DEFAULT 'llm'
                 CHECK (plugin_type IN ('llm','tool','retrieval')),
  endpoint     TEXT NOT NULL DEFAULT '',
  config       JSONB NOT NULL DEFAULT '{}',
  output_role  TEXT NOT NULL DEFAULT 'evidence'
                 CHECK (output_role IN ('candidate','evidence')),
  status       TEXT NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active','disabled')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, name)
);

CREATE INDEX IF NOT EXISTS idx_lios_plugins_tenant ON lios_plugins(tenant_id);
CREATE INDEX IF NOT EXISTS idx_lios_plugins_status ON lios_plugins(status);

-- 2. Plugin invocation log
CREATE TABLE IF NOT EXISTS lios_plugin_invocations (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    TEXT NOT NULL,
  plugin_id    UUID NOT NULL REFERENCES lios_plugins(id) ON DELETE CASCADE,
  intent_id    UUID,
  input        JSONB NOT NULL DEFAULT '{}',
  output       JSONB NOT NULL DEFAULT '{}',
  output_role  TEXT NOT NULL CHECK (output_role IN ('candidate','evidence')),
  latency_ms   INTEGER,
  status       TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','error','timeout')),
  error_msg    TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lios_plugin_inv_plugin ON lios_plugin_invocations(plugin_id);
CREATE INDEX IF NOT EXISTS idx_lios_plugin_inv_intent ON lios_plugin_invocations(intent_id);
CREATE INDEX IF NOT EXISTS idx_lios_plugin_inv_tenant ON lios_plugin_invocations(tenant_id);

-- 3. Asset store (信息资产补充通道)
CREATE TABLE IF NOT EXISTS lios_assets (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    TEXT NOT NULL,
  name         TEXT NOT NULL,
  content      TEXT NOT NULL,
  asset_type   TEXT NOT NULL DEFAULT 'document'
                 CHECK (asset_type IN ('document','policy','knowledge','template','data')),
  scope        TEXT NOT NULL
                 CHECK (scope IN ('industry','enterprise','project','task','role')),
  scope_ref    TEXT NOT NULL DEFAULT '',
  tags         TEXT[] NOT NULL DEFAULT '{}',
  metadata     JSONB NOT NULL DEFAULT '{}',
  is_indexed   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lios_assets_tenant  ON lios_assets(tenant_id);
CREATE INDEX IF NOT EXISTS idx_lios_assets_scope   ON lios_assets(scope);
CREATE INDEX IF NOT EXISTS idx_lios_assets_type    ON lios_assets(asset_type);
CREATE INDEX IF NOT EXISTS idx_lios_assets_indexed ON lios_assets(is_indexed);
CREATE INDEX IF NOT EXISTS idx_lios_assets_fts     ON lios_assets
  USING gin(to_tsvector('simple', coalesce(name,'') || ' ' || coalesce(content,'')));

-- 4. Add tenant_id to all core tables (idempotent; default='default' for legacy rows)
ALTER TABLE lios_intents         ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE lios_candidate_packs ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE lios_evidence_items  ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE lios_decisions       ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE lios_actions         ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE lios_ledgers         ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';

CREATE INDEX IF NOT EXISTS idx_lios_intents_tenant   ON lios_intents(tenant_id);
CREATE INDEX IF NOT EXISTS idx_lios_decisions_tenant ON lios_decisions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_lios_ledgers_tenant   ON lios_ledgers(tenant_id);
CREATE INDEX IF NOT EXISTS idx_lios_packs_tenant     ON lios_candidate_packs(tenant_id);
`;

async function migrateV3() {
  const client = await pool.connect();
  try {
    console.log('[migrate-v3] Applying V3: Plugins + Assets + Multi-tenant...');
    await client.query(DDL_V3);
    console.log('[migrate-v3] Done. New tables: lios_plugins, lios_plugin_invocations, lios_assets');
    console.log('[migrate-v3] New column: tenant_id on all 6 core tables');
  } catch (err) {
    console.error('[migrate-v3] Failed:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrateV3();
