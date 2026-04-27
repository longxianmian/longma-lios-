/**
 * v10 — conversation_projections 表（v2.1 落地施工方案 T1 第 2 步）
 *
 * 派生视图缓存层。任何状态变化必须先写 lios_ledgers，再触发投影更新。
 * 派生视图绝不成为第二真相源，可随时 truncate 重建。
 *
 * 字段与白皮书 §6.2 对齐：
 *   conversation_id          PK
 *   projection_data          jsonb（含 inferred_phase / pending_slots / ... / last_system_question）
 *   computed_from_ledger_seq bigint（来自 lios_ledgers.seq，单调）
 *   computed_at              timestamptz
 *
 * 回滚：见 migrate_v10_down.ts
 */

import 'dotenv/config';
import { pool } from './client';

const DDL_V10 = `
CREATE TABLE IF NOT EXISTS conversation_projections (
  conversation_id          TEXT        PRIMARY KEY,
  projection_data          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  computed_from_ledger_seq BIGINT      NOT NULL DEFAULT 0,
  computed_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conv_projections_seq
  ON conversation_projections (computed_from_ledger_seq);
`;

async function run() {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(DDL_V10);
    await c.query('COMMIT');
    console.log('✅ migrate_v10 done — conversation_projections');
  } catch (e) {
    await c.query('ROLLBACK');
    console.error('❌ migrate_v10 failed:', e);
    process.exitCode = 1;
  } finally {
    c.release();
    await pool.end();
  }
}

run();
