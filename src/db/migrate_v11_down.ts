/**
 * v11 回滚 —— 删除 lios_trace_links 表
 */

import 'dotenv/config';
import { pool } from './client';

const DDL_V11_DOWN = `
DROP INDEX IF EXISTS idx_lios_trace_links_app;
DROP INDEX IF EXISTS idx_lios_trace_links_tenant;
DROP TABLE IF EXISTS lios_trace_links;
`;

async function run() {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(DDL_V11_DOWN);
    await c.query('COMMIT');
    console.log('↩️  migrate_v11_down done — lios_trace_links 已删除');
  } catch (e) {
    await c.query('ROLLBACK');
    console.error('❌ migrate_v11_down failed:', e);
    process.exitCode = 1;
  } finally {
    c.release();
    await pool.end();
  }
}

run();
