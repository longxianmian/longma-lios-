/**
 * src/policy/policies/index.ts — γ-4 文件结构重构 (#E (ii) 完整拆分)
 *
 * Barrel re-export 所有 policy 常量 + policyById map。
 *
 * γ-4 终态：4 个 policy (electric_commerce / healthcare_consult / tianwen / biaodian)。
 *
 * 调用方式：
 *   import { ElectricCommercePolicy, policyById } from 'src/policy/policies';
 */

import type { TenantPolicy } from '../TenantPolicy';
import { ElectricCommercePolicy } from './electric_commerce';
import { HealthcareConsultPolicy } from './healthcare_consult';
import { TianwenPolicy } from './tianwen';
import { BiaodianPolicy } from './biaodian';

export { ElectricCommercePolicy } from './electric_commerce';
export { HealthcareConsultPolicy } from './healthcare_consult';
export { TianwenPolicy } from './tianwen';
export { BiaodianPolicy } from './biaodian';

/**
 * `lios_tenant_policies.policy_id` → policy 常量映射。
 *
 * 用于 src/service/createGovernanceServiceFromDB.ts 工厂从 DB 加载时查找。
 *
 * 找不到 policy_id → 启动时工厂抛错（γ-3 红线 #3：找不到 → 启动失败，不静默）。
 */
export const policyById: Readonly<Record<string, TenantPolicy>> = Object.freeze({
  electric_commerce: ElectricCommercePolicy,
  healthcare:        HealthcareConsultPolicy,
  tianwen:           TianwenPolicy,
  biaodian:          BiaodianPolicy,
});
