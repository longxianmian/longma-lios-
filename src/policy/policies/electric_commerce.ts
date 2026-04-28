/**
 * ElectricCommercePolicy — v2.1 P1 遗留, electric_commerce 行业占位 policy。
 *
 * 绑定 tenant_id='demo' (lios_tenants + lios_tenant_policies 已落 DB)。
 * γ-4 文件结构重构：从 src/policy/TenantPolicy.ts 迁移到 src/policy/policies/。
 * 业务内容完全不变（γ-3 锚点 + 业务断言保持）。
 */

import type { ClaimType } from '../../extractor/ClaimExtractor';
import type {
  TenantPolicy,
  CandidateActionTemplate,
  IdempotencyScope,
  SlotDef,
} from '../TenantPolicy';

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
