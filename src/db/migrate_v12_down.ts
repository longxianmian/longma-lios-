/**
 * v12 回滚 —— 删除 lios_tenants 表
 *
 * ⚠️ γ-5 lios_access_tokens 表会以 tenant_id 外键引用 lios_tenants。
 * 回滚 v12 前必须先回滚 v13（或不应在 v13 之后单独 down v12）。
 */

import 'dotenv/config';
import { pool } from './client';

const DDL_V12_DOWN = `
DROP INDEX IF EXISTS idx_lios_tenants_active;
DROP TABLE IF EXISTS lios_tenants;
`;

async function run() {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(DDL_V12_DOWN);
    await c.query('COMMIT');
    console.log('↩️  migrate_v12_down done — lios_tenants 已删除');
  } catch (e) {
    await c.query('ROLLBACK');
    console.error('❌ migrate_v12_down failed:', e);
    process.exitCode = 1;
  } finally {
    c.release();
    await pool.end();
  }
}

run();
