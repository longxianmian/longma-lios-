/**
 * TenantPolicyRegistry — v2.2 Phase γ-1
 *
 * 把 v2.1 中硬编码的 `loadTenantPolicy()` 函数 + REGISTRY const 升级为
 * 可注入的 class，准备给 γ-2/γ-3 接 DB 加载 policy 留出扩展点。
 *
 * 设计约束（γ-1 决议）：
 *   - register(tenantId, policy)：接受 TenantPolicy 实例（值，不接受 PolicyClass）；
 *     duplicate registration 抛错（避免静默覆盖）；register 时 Object.freeze 防止 mutation。
 *   - get(tenantId)：missing 抛错（不返回 null）。这是有意的多租户安全边界——
 *     v2.1 fallback 到 default 在多租户场景下会让 tenant_id 写错走错租户，
 *     不可接受；missing throw 让 API 层立刻看到（400/E_REQ_001）。
 *   - list()：返回已注册 tenantId 列表（用于诊断 / dashboard）。
 */

import type { TenantPolicy } from '../TenantPolicy';

export class TenantPolicyRegistry {
  private readonly policies = new Map<string, TenantPolicy>();

  register(tenantId: string, policy: TenantPolicy): void {
    if (this.policies.has(tenantId)) {
      throw new Error(`TenantPolicyRegistry: tenant already registered: ${tenantId}`);
    }
    this.policies.set(tenantId, Object.freeze(policy));
  }

  get(tenantId: string): TenantPolicy {
    const policy = this.policies.get(tenantId);
    if (!policy) {
      throw new Error(`TenantPolicyRegistry: tenant not registered: ${tenantId}`);
    }
    return policy;
  }

  list(): string[] {
    return Array.from(this.policies.keys());
  }
}
