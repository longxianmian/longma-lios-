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
 * T5 范围：
 *   - 实现 ElectricCommercePolicy（电商默认）
 *   - 提供 loadTenantPolicy(tenant_id)，硬编码加载（T11 可考虑接 DB）
 *   - 不写进 LIKernel
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

// ─────────────────────────────────────────────────────────────────────────────
// ElectricCommercePolicy（电商默认）
// ─────────────────────────────────────────────────────────────────────────────

export const ElectricCommercePolicy: TenantPolicy = Object.freeze({
  tenant_id: 'demo',
  industry: 'electric_commerce',

  recognized_claim_types: Object.freeze<ClaimType[]>([
    'refund.request',
    'order.query',
    'order.source_assertion',
    'inquiry.product',
    'inquiry.price',
    'inquiry.return_policy',
    'inquiry.capability',
    'external_service.request',
    'purchase.assertion',
    'defect.assertion',
    'escalation.request',
    'greeting',
    'chitchat',
    'unknown.business',
    'meta.confirmation',
    'meta.negation',
    'meta.unclear',
  ]),

  slot_definitions: Object.freeze({
    'refund.request': Object.freeze([
      Object.freeze({ name: 'order_id',     required: true,  source: 'user' as const,
                       description: '退款必须指向具体订单' }),
      Object.freeze({ name: 'refund_reason', required: true, source: 'user' as const,
                       description: '退款原因（残次/不喜欢/超时未收）' }),
    ]),
    'order.query': Object.freeze([
      Object.freeze({ name: 'order_id', required: true, source: 'user' as const }),
    ]),
    'inquiry.product': Object.freeze([
      Object.freeze({ name: 'product_name', required: false, source: 'user' as const }),
    ]),
  }) as Readonly<Record<string, ReadonlyArray<SlotDef>>>,

  candidate_action_templates: Object.freeze<CandidateActionTemplate[]>([
    Object.freeze({
      action_type: 'refund.initiate',
      // refund.request 单独不含证据；当带 order.query 且 verifier 返回 → 证据等级整体抬升
      derived_from_claim_types: Object.freeze<ClaimType[]>(['refund.request', 'order.query']),
      required_slots: Object.freeze(['order_id', 'refund_reason']),
      idempotency_scope: 'order_id+refund_reason' as IdempotencyScope,
      minimum_evidence_level: 3,            // 至少 ledger_record 或更高
    }),
    Object.freeze({
      action_type: 'order.lookup',
      derived_from_claim_types: Object.freeze<ClaimType[]>(['order.query']),
      required_slots: Object.freeze(['order_id']),
      idempotency_scope: 'order_id+channel' as IdempotencyScope,
      minimum_evidence_level: 1,
    }),
    Object.freeze({
      action_type: 'handoff.transfer',
      derived_from_claim_types: Object.freeze<ClaimType[]>(['escalation.request']),
      required_slots: Object.freeze([]),
      idempotency_scope: 'conversation' as IdempotencyScope,
      minimum_evidence_level: 1,
    }),
    Object.freeze({
      action_type: 'inquiry.answer',
      derived_from_claim_types: Object.freeze<ClaimType[]>([
        'inquiry.product', 'inquiry.price', 'inquiry.return_policy', 'inquiry.capability',
      ]),
      required_slots: Object.freeze([]),
      idempotency_scope: 'user_input_hash+conversation' as IdempotencyScope,
      minimum_evidence_level: 1,
    }),
    Object.freeze({
      action_type: 'capability.deflect',
      derived_from_claim_types: Object.freeze<ClaimType[]>(['inquiry.capability']),
      required_slots: Object.freeze([]),
      idempotency_scope: 'user_input_hash+conversation' as IdempotencyScope,
      minimum_evidence_level: 1,
    }),
    // 用户主张曾购买但缺核验 → hold 收集购买证明
    Object.freeze({
      action_type: 'purchase.verify',
      derived_from_claim_types: Object.freeze<ClaimType[]>(['purchase.assertion']),
      required_slots: Object.freeze(['order_id']),
      idempotency_scope: 'order_id+channel' as IdempotencyScope,
      minimum_evidence_level: 3,           // 至少 ledger_record 才视为已验证
    }),
    // 用户主张缺陷 → hold 收集订单 + 缺陷证明
    Object.freeze({
      action_type: 'defect.collect_proof',
      derived_from_claim_types: Object.freeze<ClaimType[]>(['defect.assertion']),
      required_slots: Object.freeze(['order_id', 'defect_proof']),
      idempotency_scope: 'order_id+refund_reason' as IdempotencyScope,
      minimum_evidence_level: 3,
    }),
    // 用户希望转人工 → 先 intake 收集订单 + 投诉摘要
    Object.freeze({
      action_type: 'escalation.intake',
      derived_from_claim_types: Object.freeze<ClaimType[]>(['escalation.request']),
      required_slots: Object.freeze(['order_id', 'complaint_summary']),
      idempotency_scope: 'conversation' as IdempotencyScope,
      minimum_evidence_level: 1,
    }),
    // 用户输入完全无法解析 / 未知业务 → 追问澄清
    Object.freeze({
      action_type: 'intent.clarify',
      derived_from_claim_types: Object.freeze<ClaimType[]>(['meta.unclear', 'unknown.business']),
      required_slots: Object.freeze(['clarified_intent']),
      idempotency_scope: 'user_input_hash+conversation' as IdempotencyScope,
      minimum_evidence_level: 1,
    }),
  ]),

  escalation_threshold: 3,

  forbidden_commitments: Object.freeze([
    'commit_refund_completed',     // 不允许说"已为您退款"
    'commit_order_existence',      // 不允许在 verifier 之前承诺订单存在
    'fabricate_order_id',          // 不允许编造订单号
    'fabricate_kb_content',        // 不允许编造 KB 没有的产品/价格/政策
  ]),

  bounds_template: Object.freeze({
    must: Object.freeze([
      'be_polite',
      'use_zh_TW',
      'respect_evidence_law',
    ]),
    must_not: Object.freeze([
      'fabricate_facts',
      'commit_unverified',
      'leak_internal_terms',
    ]),
    may: Object.freeze([
      'ask_clarifying_question',
      'guide_to_known_products',
    ]),
  }),

  // v2.1 §5.6：电商租户里这几类主张明确不在业务范围 → reject
  reject_claim_types: Object.freeze<ClaimType[]>([
    'chitchat',                  // 闲聊（"今天下雪 / 曼谷下雪了好棒"）
    'greeting',                  // 单纯打招呼也归为 reject（让客服流程聚焦）
    'external_service.request',  // 外部服务请求（"foodpanda 订餐"、"叫快递"）
  ]),

  // 主张不在识别集（如能力越界、外部服务）→ 默认 reject
  out_of_scope_default: 'reject',
});

// ─────────────────────────────────────────────────────────────────────────────
// 第二个 policy（便于 T5 验收"不同租户加载不同 policy"）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 占位医疗咨询 policy —— 用于跨行业测试，不进入生产链路。
 * 真实落地需要医师审核词条、严格的 forbidden_commitments 等。
 */
export const HealthcareConsultPolicy: TenantPolicy = Object.freeze({
  tenant_id: 'healthcare-demo',
  industry: 'healthcare',

  recognized_claim_types: Object.freeze<ClaimType[]>([
    'inquiry.product',          // 在医疗语境下指 inquiry about treatment/medicine
    'inquiry.capability',
    'escalation.request',       // 转人工医师
    'greeting',
    'chitchat',
    'unknown.business',
    'meta.confirmation',
    'meta.negation',
    'meta.unclear',
  ]),

  slot_definitions: Object.freeze({}),

  candidate_action_templates: Object.freeze<CandidateActionTemplate[]>([
    Object.freeze({
      action_type: 'handoff.transfer',
      derived_from_claim_types: Object.freeze<ClaimType[]>(['escalation.request']),
      required_slots: Object.freeze([]),
      idempotency_scope: 'conversation' as IdempotencyScope,
      minimum_evidence_level: 1,
    }),
    Object.freeze({
      action_type: 'inquiry.answer',
      derived_from_claim_types: Object.freeze<ClaimType[]>([
        'inquiry.product', 'inquiry.capability',
      ]),
      required_slots: Object.freeze([]),
      idempotency_scope: 'user_input_hash+conversation' as IdempotencyScope,
      minimum_evidence_level: 4,    // 医疗强制 KB 命中
    }),
  ]),

  escalation_threshold: 2,         // 医疗更敏感，更早升级

  forbidden_commitments: Object.freeze([
    'medical_diagnosis',           // 不允许 AI 给出诊断
    'medication_dosage',
    'fabricate_kb_content',
  ]),

  bounds_template: Object.freeze({
    must: Object.freeze(['be_polite', 'recommend_professional_when_uncertain']),
    must_not: Object.freeze(['diagnose', 'prescribe', 'fabricate_facts']),
    may: Object.freeze(['ask_clarifying_question']),
  }),

  reject_claim_types: Object.freeze<ClaimType[]>(['chitchat', 'greeting']),
  out_of_scope_default: 'hold_clarify',     // 医疗咨询里宁可追问也不直接 reject
});

// ─────────────────────────────────────────────────────────────────────────────
// Loader（按 tenant_id 加载 policy）
// ─────────────────────────────────────────────────────────────────────────────

const REGISTRY: Readonly<Record<string, TenantPolicy>> = Object.freeze({
  demo:             ElectricCommercePolicy,
  default:          ElectricCommercePolicy,
  'healthcare-demo': HealthcareConsultPolicy,
});

export function loadTenantPolicy(tenant_id: string): TenantPolicy {
  return REGISTRY[tenant_id] ?? REGISTRY.default;
}
