/**
 * HealthcareConsultPolicy — v2.1 P1 遗留, healthcare 行业占位 policy。
 *
 * γ-3 后无 tenant 在 lios_tenant_policies 引用 'healthcare' policy_id；
 * policyById 保留 entry 作 γ-4+ 备用（医疗咨询场景未来可绑新 tenant_id）。
 * γ-4 文件结构重构：从 src/policy/TenantPolicy.ts 迁移到 src/policy/policies/。
 * 业务内容完全不变。
 *
 * 真实落地需要医师审核词条、严格的 forbidden_commitments 等。
 */

import type { ClaimType } from '../../extractor/ClaimExtractor';
import type {
  TenantPolicy,
  CandidateActionTemplate,
  IdempotencyScope,
} from '../TenantPolicy';

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
