/**
 * v13 回滚 —— 删除 tianwen-demo + biaodian-demo 占位 tenant + policy
 *
 * DELETE 顺序：先 lios_tenant_policies 再 lios_tenants（与 INSERT 相反）
 * 虽然 lios_tenant_policies.tenant_id 上有 ON DELETE CASCADE，但显式 DELETE 更安全：
 *   - 不依赖 CASCADE 行为
 *   - 失败时 ROLLBACK 边界更清晰
 *   - 'demo' 商户和 policy 完全不受影响
 */

import 'dotenv/config';
import { pool } from './client';

const DELETE_POLICIES_V13_DOWN = `
DELETE FROM lios_tenant_policies
WHERE tenant_id IN ('tianwen-demo', 'biaodian-demo');
`;

const DELETE_TENANTS_V13_DOWN = `
DELETE FROM lios_tenants
WHERE tenant_id IN ('tianwen-demo', 'biaodian-demo');
`;

async function run() {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    // 顺序: 先 lios_tenant_policies 再 lios_tenants (与 INSERT 相反)
    await c.query(DELETE_POLICIES_V13_DOWN);
    await c.query(DELETE_TENANTS_V13_DOWN);
    await c.query('COMMIT');
    console.log('↩️  migrate_v13_down done — tianwen-demo + biaodian-demo 已删除');
  } catch (e) {
    await c.query('ROLLBACK');
    console.error('❌ migrate_v13_down failed:', e);
    process.exitCode = 1;
  } finally {
    c.release();
    await pool.end();
  }
}

run();
