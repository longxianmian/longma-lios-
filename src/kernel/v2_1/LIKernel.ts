/**
 * LI Kernel v2.1（白皮书 §5.6）
 *
 * 内核纯净性原则：
 *   - 内核仅内置两条物理律
 *   - TenantPolicy 作为 KernelInput 字段传入；Kernel 不持有任何租户字段
 *   - 同一个 Kernel 实例评估所有租户
 *
 * 严格不做（施工方案 T6）：
 *   - 不让 Kernel 持有 tenant_policy / policy / tenantConfig 字段
 *   - 不让 Kernel 调 LLM
 *   - 不接 BoundedLLMGenerator（T8 才接）
 *
 * 内核字段静态扫描见 tests/kernel/likernel.test.ts。
 */

import type { KernelInput } from '../../builder/CandidatePackBuilder';
import type { CandidateAction } from '../../builder/CandidatePackBuilder';
import type { TenantPolicy, BoundsTemplate } from '../../policy/TenantPolicy';
import { EvidenceLaw } from './EvidenceLaw';
import { ConservationLaw } from './ConservationLaw';
import type { EvidenceLawResult } from './EvidenceLaw';
import type { ConservationLawResult, CommittedReference } from './ConservationLaw';

// ─────────────────────────────────────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────────────────────────────────────

export type KernelVerdict = 'accept' | 'hold' | 'reject';

export interface Bounds {
  readonly must: ReadonlyArray<string>;
  readonly must_not: ReadonlyArray<string>;
  readonly may: ReadonlyArray<string>;
  readonly pending_slot?: string;
  readonly pending_action?: string;
}

export interface Decision {
  readonly verdict: KernelVerdict;
  readonly reason: string;
  readonly bounds: Bounds;
  readonly chosen_actions: ReadonlyArray<CandidateAction>;
  readonly referenced_actions?: ReadonlyArray<CommittedReference>;   // 律 2 命中时
  readonly law1: EvidenceLawResult;
  readonly law2: ConservationLawResult;
  readonly should_escalate?: boolean;                                // 超阈值时为 true
}

// ─────────────────────────────────────────────────────────────────────────────
// LIKernel —— 仅内置两条律
// ─────────────────────────────────────────────────────────────────────────────

export class LIKernel {
  // 内核唯一持有的状态：两条律
  private readonly law1_evidenceClosure: EvidenceLaw;
  private readonly law2_ledgerConservation: ConservationLaw;

  constructor() {
    this.law1_evidenceClosure   = new EvidenceLaw();
    this.law2_ledgerConservation = new ConservationLaw();
  }

  /**
   * Kernel 主裁决方法。tenant_policy 来自 input，不来自 this。
   */
  decide(input: KernelInput): Decision {
    const policy: TenantPolicy = input.tenant_policy;

    // 1) 律 1：证据闭合
    const law1 = this.law1_evidenceClosure.evaluate(
      input.claims,
      input.evidence_pack,
      input.candidate_actions,
    );
    if (law1.violated) {
      return holdOnLaw1(input, policy, law1);
    }

    // 2) 律 2：账本守恒
    const law2 = this.law2_ledgerConservation.evaluate(
      input.candidate_actions,
      {
        projection: input.projection,
        escalation_threshold: policy.escalation_threshold,
      },
    );

    if (law2.violated) {
      // 已 committed → 返回引用而非新生成
      return acceptReferencedExisting(input, policy, law1, law2);
    }

    // 3) 评估 TenantPolicy（作为传入参数，不固化进 Kernel）
    const policyResult = evaluateTenantPolicy(input, policy);
    if (policyResult.rejected) {
      return reject(input, policy, law1, law2, policyResult.reason);
    }

    // 3.5) 槽位不全 hold 检查（白皮书 §4.4：物理律之外的工程化推导）
    //      对每个 candidate_action，看 required_slots 是否都已 filled
    //      未满足 → hold + bounds.pending_slot 指向缺失的第一个槽
    const slotHold = checkSlotPending(input);
    if (slotHold) {
      return holdOnSlot(input, policy, law1, law2, slotHold);
    }

    // 4) 输出 Decision + Bounds
    return accept(input, policy, law1, law2);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Verdict 构造器
// ─────────────────────────────────────────────────────────────────────────────

function accept(
  input: KernelInput,
  policy: TenantPolicy,
  law1: EvidenceLawResult,
  law2: ConservationLawResult,
): Decision {
  const bounds = deriveBounds(input, policy, 'accept');
  return Object.freeze({
    verdict: 'accept' as KernelVerdict,
    reason: law2.should_escalate ? 'accept_with_escalation' : 'evidence_ok',
    bounds,
    chosen_actions: input.candidate_actions,
    law1,
    law2,
    ...(law2.should_escalate ? { should_escalate: true } : {}),
  });
}

interface SlotHoldInfo {
  readonly action_type: string;
  readonly missing_slot: string;
}

function checkSlotPending(input: KernelInput): SlotHoldInfo | null {
  if (input.candidate_actions.length === 0) return null;
  const filledSlotNames = new Set<string>(
    (input.projection?.filled_slots ?? []).map(s => s.name),
  );
  // 也把 claim.content 里现成的 slot value 视为"已填"（首轮即可一次填完）
  for (const c of input.claims) {
    const cnt = c.content as Record<string, unknown>;
    for (const k of Object.keys(cnt)) {
      if (cnt[k] !== undefined && cnt[k] !== null && cnt[k] !== '') {
        filledSlotNames.add(k);
      }
    }
  }

  for (const action of input.candidate_actions) {
    for (const slot of action.required_slots) {
      if (!filledSlotNames.has(slot)) {
        return { action_type: action.action_type, missing_slot: slot };
      }
    }
  }
  return null;
}

function holdOnSlot(
  input: KernelInput,
  policy: TenantPolicy,
  law1: EvidenceLawResult,
  law2: ConservationLawResult,
  info: SlotHoldInfo,
): Decision {
  const baseBounds = deriveBounds(input, policy, 'hold', info.action_type);
  const bounds: Bounds = Object.freeze({
    ...baseBounds,
    pending_slot: info.missing_slot,
  });
  return Object.freeze({
    verdict: 'hold' as KernelVerdict,
    reason: `slot_pending:${info.action_type}:${info.missing_slot}`,
    bounds,
    chosen_actions: [],
    law1,
    law2,
    ...(law2.should_escalate ? { should_escalate: true } : {}),  // 传播律 2 的升级建议
  });
}

function holdOnLaw1(
  input: KernelInput,
  policy: TenantPolicy,
  law1: EvidenceLawResult,
): Decision {
  const baseBounds = deriveBounds(input, policy, 'hold', law1.violating_action_type);
  // 律 1 hold 时把 pending_slot 设为违律 action 的首个未填 required_slot
  const violatingAction = input.candidate_actions.find(
    a => a.action_type === law1.violating_action_type,
  );
  let pending_slot = baseBounds.pending_slot;
  if (violatingAction && violatingAction.required_slots.length > 0) {
    const filled = new Set<string>([
      ...(input.projection?.filled_slots ?? []).map(s => s.name),
      ...input.claims.flatMap(c => Object.keys(c.content as Record<string, unknown>)
        .filter(k => (c.content as Record<string, unknown>)[k] !== undefined &&
                     (c.content as Record<string, unknown>)[k] !== null &&
                     (c.content as Record<string, unknown>)[k] !== '')),
    ]);
    pending_slot = violatingAction.required_slots.find(s => !filled.has(s)) ?? pending_slot;
  }
  const bounds: Bounds = Object.freeze({
    ...baseBounds,
    ...(pending_slot ? { pending_slot } : {}),
  });
  return Object.freeze({
    verdict: 'hold' as KernelVerdict,
    reason: law1.reason,
    bounds,
    chosen_actions: [],
    law1,
    law2: Object.freeze({ violated: false, reason: 'not_evaluated' }),
    // 注意：holdOnLaw1 时律 2 还没评估；should_escalate 在 holdOnSlot 路径才传播
  });
}

function acceptReferencedExisting(
  input: KernelInput,
  policy: TenantPolicy,
  law1: EvidenceLawResult,
  law2: ConservationLawResult,
): Decision {
  const bounds = deriveBounds(input, policy, 'accept');
  return Object.freeze({
    verdict: 'accept' as KernelVerdict,
    reason: 'reference_existing',
    bounds,
    chosen_actions: [],
    referenced_actions: law2.already_committed,
    law1,
    law2,
    ...(law2.should_escalate ? { should_escalate: true } : {}),
  });
}

function reject(
  input: KernelInput,
  policy: TenantPolicy,
  law1: EvidenceLawResult,
  law2: ConservationLawResult,
  reason: string,
): Decision {
  const bounds = deriveBounds(input, policy, 'reject');
  return Object.freeze({
    verdict: 'reject' as KernelVerdict,
    reason,
    bounds,
    chosen_actions: [],
    law1,
    law2,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// TenantPolicy 评估（作为输入参数；不固化）
// ─────────────────────────────────────────────────────────────────────────────

interface PolicyEvalResult {
  readonly rejected: boolean;
  readonly reason: string;
  readonly hold_reason?: string;
}

function evaluateTenantPolicy(input: KernelInput, policy: TenantPolicy): PolicyEvalResult {
  // 1. 明确 reject：claim.type 在 reject_claim_types 集合内
  //    （v2.1 §5.6：Policy 评估职责；§3.2：人为规则由企业定义）
  const rejectedClaim = input.claims.find(c => policy.reject_claim_types.includes(c.type));
  if (rejectedClaim) {
    return Object.freeze({
      rejected: true,
      reason: `policy_reject_claim:${rejectedClaim.type}`,
    });
  }

  // 2. 越界（不在 recognized_claim_types 中）—— 按 out_of_scope_default 分流
  const outOfScope = input.claims.find(c => !policy.recognized_claim_types.includes(c.type));
  if (outOfScope) {
    if (policy.out_of_scope_default === 'reject') {
      return Object.freeze({
        rejected: true,
        reason: `policy_out_of_scope:${outOfScope.type}`,
      });
    }
    // hold_clarify：不直接 reject，让 hold 路径接管
    return Object.freeze({
      rejected: false,
      reason: 'policy_hold_clarify',
      hold_reason: `out_of_scope:${outOfScope.type}`,
    });
  }

  // 3. 当 claims 全是低承诺度（chitchat/greeting/meta.*/unknown.business 之外的业务主张）
  //    且没有 candidate_action 派生 → 律 1 不会触发；这里也不 reject。
  return Object.freeze({ rejected: false, reason: 'policy_ok' });
}

// ─────────────────────────────────────────────────────────────────────────────
// Bounds 推导
// ─────────────────────────────────────────────────────────────────────────────

function deriveBounds(
  input: KernelInput,
  policy: TenantPolicy,
  verdict: KernelVerdict,
  pendingActionType?: string,
): Bounds {
  const tpl: BoundsTemplate = policy.bounds_template;

  const must: string[] = [...tpl.must];
  const must_not: string[] = [...tpl.must_not, ...policy.forbidden_commitments];
  const may: string[] = [...tpl.may];

  // verdict 相关 bounds
  if (verdict === 'hold') {
    must.push('ask_for_evidence_or_clarify');
    must_not.push('commit_unverified_facts');
  }
  if (verdict === 'reject') {
    must.push('decline_politely', 'redirect_to_business_topics');
    must_not.push('expand_scope', 'use_simplified_chinese_when_zh_TW');
  }
  if (verdict === 'accept') {
    must.push('cite_evidence_when_factual');
  }

  // pending_slot：找首个未填的必填 slot
  let pending_slot: string | undefined;
  if (verdict === 'hold' && input.projection) {
    pending_slot = input.projection.pending_slots[0]?.name;
  }

  return Object.freeze({
    must: Object.freeze(must),
    must_not: Object.freeze(must_not),
    may: Object.freeze(may),
    ...(pending_slot ? { pending_slot } : {}),
    ...(pendingActionType ? { pending_action: pendingActionType } : {}),
  });
}

// 单例（Runtime 用同一个 Kernel 实例评估所有租户）
export const liKernelV21 = new LIKernel();
