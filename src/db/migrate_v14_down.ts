/**
 * v14 回滚 —— 删除 lios_access_tokens 表
 */

import 'dotenv/config';
import { pool } from './client';

const DDL_V14_DOWN = `
DROP INDEX IF EXISTS idx_lios_access_tokens_tenant;
DROP TABLE IF EXISTS lios_access_tokens;
`;

async function run() {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(DDL_V14_DOWN);
    await c.query('COMMIT');
    console.log('↩️  migrate_v14_down done — lios_access_tokens 已删除');
  } catch (e) {
    await c.query('ROLLBACK');
    console.error('❌ migrate_v14_down failed:', e);
    process.exitCode = 1;
  } finally {
    c.release();
    await pool.end();
  }
}

run();
