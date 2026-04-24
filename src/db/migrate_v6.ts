import 'dotenv/config';
import { pool } from './client';

async function migrateV6() {
  const client = await pool.connect();
  try {
    console.log('[migrate-v6] P1 tables...');

    // pgvector (needed for future SQL-side similarity search)
    await client.query(`CREATE EXTENSION IF NOT EXISTS vector`).catch(() => {
      console.log('[migrate-v6] pgvector not available, skipping');
    });

    // Embedding cache
    await client.query(`
      CREATE TABLE IF NOT EXISTS lios_embedding_cache (
        id         UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
        text_hash  VARCHAR UNIQUE NOT NULL,
        embedding  float4[],
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Hold contexts for multi-round 补证
    await client.query(`
      CREATE TABLE IF NOT EXISTS lios_hold_contexts (
        id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        trace_id             UUID,
        tenant_id            VARCHAR,
        session_id           VARCHAR,
        original_intent_json JSONB,
        missing_info_json    JSONB,
        collected_info_json  JSONB DEFAULT '{}',
        hold_attempt         INTEGER DEFAULT 1,
        expires_at           TIMESTAMP,
        created_at           TIMESTAMP DEFAULT NOW()
      )
    `);

    // LLM cost tracking
    await client.query(`
      CREATE TABLE IF NOT EXISTS lios_llm_calls (
        id            UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
        trace_id      UUID,
        tenant_id     VARCHAR,
        provider      VARCHAR,
        model         VARCHAR,
        call_type     VARCHAR,
        tokens_input  INTEGER,
        tokens_output INTEGER,
        cost_usd      DECIMAL(10,6),
        latency_ms    INTEGER,
        created_at    TIMESTAMP DEFAULT NOW()
      )
    `);

    console.log('[migrate-v6] Done ✓');
  } catch (err) {
    console.error('[migrate-v6] Failed:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrateV6();
