/**
 * createGovernanceServiceFromDB — γ-3 启动时从 DB 加载租户 policy 并注入 service。
 *
 * 流程：
 *   1. 新建 TenantPolicyRegistry
 *   2. SELECT tenant_id, policy_id FROM lios_tenant_policies WHERE is_active = true
 *   3. 对每行 lookup policyById[policy_id] → 找不到抛错（启动失败）
 *   4. registry.register(tenant_id, policy)
 *   5. 返回 new LIOSGovernanceService(registry)
 *
 * 设计边界（γ-3 红线 §4）:
 *   #1 LIOSGovernanceService.constructor 必填 registry，无默认值
 *   #3 找不到 policy_id 对应 policy → 抛异常启动失败（不静默跳过）
 *   #4 启动时 DB 连不上 → 抛异常启动失败（query 自身会抛，不降级）
 *   #5 不动 TenantPolicyRegistry 内部实现，只用 public 接口
 *
 * 战略意义（γ-3 §0）:
 *   tenant 来源真正从 DB 而来，γ-1 临时硬编码注册全部清除。
 */

import { query } from '../db/client';
import { TenantPolicyRegistry } from '../policy/registry/TenantPolicyRegistry';
import { policyById } from '../policy/TenantPolicy';
import { LIOSGovernanceService } from './LIOSGovernanceService';

interface TenantPolicyRow {
  tenant_id: string;
  policy_id: string;
}

export async function createGovernanceServiceFromDB(): Promise<LIOSGovernanceService> {
  const registry = new TenantPolicyRegistry();

  const rows = await query<TenantPolicyRow>(
    `SELECT tenant_id, policy_id FROM lios_tenant_policies WHERE is_active = true`,
  );

  for (const row of rows) {
    const policy = policyById[row.policy_id];
    if (!policy) {
      throw new Error(
        `createGovernanceServiceFromDB: unknown policy_id '${row.policy_id}' for tenant_id '${row.tenant_id}' — startup aborted. Check policyById map in src/policy/TenantPolicy.ts.`,
      );
    }
    registry.register(row.tenant_id, policy);
  }

  console.log(
    `✅ loaded ${rows.length} tenant policies from DB: [${rows.map(r => r.tenant_id).join(', ')}]`,
  );

  return new LIOSGovernanceService(registry);
}
