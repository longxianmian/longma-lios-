/**
 * LIOSGovernanceService — v2.2 无状态治理决策服务。
 *
 * 严格遵循《拆分边界书 v0.1》§1：
 *   - 不持有任何成员变量
 *   - 不读 ledger
 *   - 不写 ledger
 *   - 不维护 session 状态
 *   - 但接收 projection_snapshot 作为参数（律 2 累计的"读"侧）
 *
 * 同样的 (req) → 同样的 result。
 *
 * α-2：仅骨架；实际治理决策迁移在 α-3 完成。
 */

import type { DecideRequest, DecideResult } from './types';

export class LIOSGovernanceService {
  // ⚠️ 不允许有任何成员字段（边界书 §1.2 / §3.3）
  // ⚠️ 不允许构造函数接收 ledger / projection 实例

  async decide(_req: DecideRequest): Promise<DecideResult> {
    // α-3 实现真实治理逻辑：
    //   ClaimExtractor → EvidenceBinder → CandidatePackBuilder
    //     → LIKernel(projection_snapshot) → BoundedLLMGenerator
    //     → ActionResolver(compute) → BoundsAuditor(audit + retry)
    //     → 组装 LedgerPayload 返回
    throw new Error('Not implemented yet (will be migrated in α-3)');
  }
}
