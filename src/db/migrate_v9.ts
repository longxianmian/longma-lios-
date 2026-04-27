/**
 * v9 — Ledger 增强（v2.1 落地施工方案 T1 第 1 步）
 *
 * 给 lios_ledgers 增加 v2.1 治理管线的结构化列：
 *   conversation_id / claims / evidence_pack / bounds / action_id / action_status / seq
 *
 * 设计纪律：
 * - 全部加为 NULL，旧 writeLedger 不传新字段也能工作
 * - action_status CHECK 仅约束非空值，允许 NULL
 * - 复合索引 (conversation_id, action_id, action_status)
 *   仅对 action_id 非空的行建（部分索引），用于 ActionResolver 快速查询
 * - seq bigserial 给 ConversationProjection 计算 computed_from_ledger_seq
 *
 * 不做：
 * - 不改任何旧字段
 * - 不修改业务代码
 *
 * 回滚：见 migrate_v9_down.ts
 */

import 'dotenv/config';
import { pool } from './client';

const DDL_V9 = `
-- 1) 结构化列（全部允许 NULL）
ALTER TABLE lios_ledgers
  ADD COLUMN IF NOT EXISTS conversation_id TEXT,
  ADD COLUMN IF NOT EXISTS claims          JSONB,
  ADD COLUMN IF NOT EXISTS evidence_pack   JSONB,
  ADD COLUMN IF NOT EXISTS bounds          JSONB,
  ADD COLUMN IF NOT EXISTS action_id       TEXT,
  ADD COLUMN IF NOT EXISTS action_status   TEXT;

-- 2) action_status 取值约束（NULL 允许）
DO $$ BEGIN
  ALTER TABLE lios_ledgers
    ADD CONSTRAINT lios_ledgers_action_status_v9_check
    CHECK (action_status IS NULL OR action_status IN ('pending','committed','cancelled'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 3) ledger 单调序列号（给 ConversationProjection 用）
ALTER TABLE lios_ledgers
  ADD COLUMN IF NOT EXISTS seq BIGSERIAL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_lios_ledgers_seq
  ON lios_ledgers (seq);

-- 4) ActionResolver 查询用复合索引（部分索引，省空间）
CREATE INDEX IF NOT EXISTS idx_lios_ledgers_conv_action
  ON lios_ledgers (conversation_id, action_id, action_status)
  WHERE action_id IS NOT NULL;

-- 5) 按 conversation_id 顺序回放（ConversationProjection 重建）
CREATE INDEX IF NOT EXISTS idx_lios_ledgers_conv_seq
  ON lios_ledgers (conversation_id, seq)
  WHERE conversation_id IS NOT NULL;
`;

async function run() {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(DDL_V9);
    await c.query('COMMIT');
    console.log('✅ migrate_v9 done — lios_ledgers 增强字段 (conversation_id/claims/evidence_pack/bounds/action_id/action_status/seq)');
  } catch (e) {
    await c.query('ROLLBACK');
    console.error('❌ migrate_v9 failed:', e);
    process.exitCode = 1;
  } finally {
    c.release();
    await pool.end();
  }
}

run();
