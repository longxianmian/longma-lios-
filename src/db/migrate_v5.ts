import { pool } from './client';

const DDL_V5 = `
-- LIOS Schema V5 — Asset Embeddings (text-embedding-3-small, dim=1536)
ALTER TABLE lios_assets
  ADD COLUMN IF NOT EXISTS embedding       float4[],
  ADD COLUMN IF NOT EXISTS embedding_model TEXT;

CREATE INDEX IF NOT EXISTS idx_lios_assets_has_embedding
  ON lios_assets (tenant_id, is_indexed)
  WHERE embedding IS NOT NULL;
`;

async function migrateV5() {
  const client = await pool.connect();
  try {
    console.log('[migrate-v5] Adding embedding columns to lios_assets...');
    await client.query(DDL_V5);
    console.log('[migrate-v5] Done.');
  } catch (err) {
    console.error('[migrate-v5] Failed:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrateV5();
