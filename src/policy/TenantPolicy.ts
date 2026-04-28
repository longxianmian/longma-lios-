/**
 * TenantPolicy —— 企业级"人为规则"（白皮书 §3.2 / §5.6 / §7.2）
 *
 * v2.1 关键纪律：
 *   - TenantPolicy 是 Kernel 的"输入参数"，**不是 Kernel 的成员字段**
 *   - 不同租户的 policy 用同一个 Kernel 实例评估
 *   - 不固化进 Kernel；Kernel 不持有任何 tenant 状态
 *
 * 跨行业可变项（白皮书 §7.2）：
 *   - 可识别的主张类型集（业务主张 + 元主张）
 *   - 槽位定义（每个 intent 需要哪些必填信息）
 *   - 证据要求 / KB 锚点
 *   - 升级阈值（默认 3，可调）
 *   - 安全边界（禁止承诺、禁止虚构）
 *
 * v2.2 γ-4 文件结构（#E (ii) 完整拆分）：
 *   - 本文件：interface + 5 个类型定义
 *   - src/policy/policies/{electric_commerce,healthcare_consult,tianwen,biaodian}.ts：policy const
 *   - src/policy/policies/index.ts：barrel + policyById map
 *
 * 注册路径：src/service/createGovernanceServiceFromDB() 启动时从 lios_tenant_policies
 * 表加载，通过 TenantPolicyRegistry 注入 LIOSGovernanceService。
 */

import type { ClaimType } from '../extractor/ClaimExtractor';
import type { EvidenceLevel } from '../binder/EvidenceBinder';

// ─────────────────────────────────────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────────────────────────────────────

export type IdempotencyScope =
  | 'conversation'
  | 'order_id+channel'
  | 'order_id+refund_reason'
  | 'user_id+coupon_id'
  | 'user_id+field_name'
  | 'user_input_hash+conversation';

export interface SlotDef {
  readonly name: string;
  readonly required: boolean;
  readonly source: 'user' | 'verifier' | 'kb';
  readonly description?: string;
}

/**
 * 候选动作模板。政策定义"什么主张可以触发什么动作 + 哪种幂等范围"。
 * 实例化（含具体值）由 CandidatePackBuilder 完成。
 */
export interface CandidateActionTemplate {
  readonly action_type: string;                       // refund.initiate / order.lookup / handoff.transfer
  readonly derived_from_claim_types: ReadonlyArray<ClaimType>;
  readonly required_slots: ReadonlyArray<string>;
  readonly idempotency_scope: IdempotencyScope;
  readonly minimum_evidence_level?: EvidenceLevel;     // 律 1：最低需要的证据等级
}

export interface BoundsTemplate {
  readonly must: ReadonlyArray<string>;
  readonly must_not: ReadonlyArray<string>;
  readonly may: ReadonlyArray<string>;
}

/**
 * 越界主张的处置策略：
 *   - 'reject'      → 礼貌婉拒（明显越界：闲聊、外部服务请求、公开常识闲聊）
 *   - 'hold_clarify' → 追问澄清（unknown.business / meta.unclear）
 */
export type OutOfScopeAction = 'reject' | 'hold_clarify';

export interface TenantPolicy {
  readonly tenant_id: string;
  readonly industry: string;
  readonly recognized_claim_types: ReadonlyArray<ClaimType>;
  readonly slot_definitions: Readonly<Record<string, ReadonlyArray<SlotDef>>>;     // intent → slots
  readonly candidate_action_templates: ReadonlyArray<CandidateActionTemplate>;
  readonly escalation_threshold: number;                                            // 默认 3
  readonly forbidden_commitments: ReadonlyArray<string>;                            // 律 1：安全边界
  readonly bounds_template: BoundsTemplate;

  /**
   * 明确 reject 的主张类型（v2.1 §5.6 Policy 评估职责）：
   *   - 业务越界（如电商租户里的"chitchat"无业务接续点 → reject）
   *   - 外部服务请求类（如"foodpanda 订餐" → reject）
   * 不写关键词列表；只列结构化主张类型。
   */
  readonly reject_claim_types: ReadonlyArray<ClaimType>;

  /**
   * 不在 recognized_claim_types 集合内的主张默认怎么处置。
   *   - 'reject'      ：直接婉拒
   *   - 'hold_clarify'：追问澄清
   */
  readonly out_of_scope_default: OutOfScopeAction;
}
