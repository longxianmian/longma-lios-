/**
 * v9 回滚 —— 还原 lios_ledgers 到 v8 形态
 * 注意：执行后已写入 v9 列的数据会丢失（这些列是 v2.1 增量，旧管线不依赖）
 */

import 'dotenv/config';
import { pool } from './client';

const DDL_V9_DOWN = `
DROP INDEX IF EXISTS idx_lios_ledgers_conv_seq;
DROP INDEX IF EXISTS idx_lios_ledgers_conv_action;
DROP INDEX IF EXISTS idx_lios_ledgers_seq;

ALTER TABLE lios_ledgers
  DROP CONSTRAINT IF EXISTS lios_ledgers_action_status_v9_check;

ALTER TABLE lios_ledgers
  DROP COLUMN IF EXISTS seq,
  DROP COLUMN IF EXISTS action_status,
  DROP COLUMN IF EXISTS action_id,
  DROP COLUMN IF EXISTS bounds,
  DROP COLUMN IF EXISTS evidence_pack,
  DROP COLUMN IF EXISTS claims,
  DROP COLUMN IF EXISTS conversation_id;
`;

async function run() {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(DDL_V9_DOWN);
    await c.query('COMMIT');
    console.log('↩️  migrate_v9_down done — lios_ledgers 已回滚到 v8');
  } catch (e) {
    await c.query('ROLLBACK');
    console.error('❌ migrate_v9_down failed:', e);
    process.exitCode = 1;
  } finally {
    c.release();
    await pool.end();
  }
}

run();
