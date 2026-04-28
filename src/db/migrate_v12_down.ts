/**
 * v12 回滚 —— 删除 lios_tenant_policies 表
 *
 * ⚠️ γ-5 lios_access_tokens 表会以 tenant_id 外键引用 lios_tenants（不是本表）。
 * 本表 (lios_tenant_policies) 是 lios_tenants 的下游：lios_tenants → lios_tenant_policies → ...
 * 回滚 v12 不影响 lios_tenants（CASCADE 是父表删时级联子表，本 down 是删子表本身）。
 */

import 'dotenv/config';
import { pool } from './client';

const DDL_V12_DOWN = `
DROP TABLE IF EXISTS lios_tenant_policies CASCADE;
`;

async function run() {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(DDL_V12_DOWN);
    await c.query('COMMIT');
    console.log('↩️  migrate_v12_down done — lios_tenant_policies 已删除');
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
