/**
 * v10 回滚 —— 删除 conversation_projections 表
 */

import 'dotenv/config';
import { pool } from './client';

const DDL_V10_DOWN = `
DROP INDEX IF EXISTS idx_conv_projections_seq;
DROP TABLE IF EXISTS conversation_projections;
`;

async function run() {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(DDL_V10_DOWN);
    await c.query('COMMIT');
    console.log('↩️  migrate_v10_down done — conversation_projections 已删除');
  } catch (e) {
    await c.query('ROLLBACK');
    console.error('❌ migrate_v10_down failed:', e);
    process.exitCode = 1;
  } finally {
    c.release();
    await pool.end();
  }
}

run();
