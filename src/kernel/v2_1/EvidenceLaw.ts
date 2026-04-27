/**
 * 律 1：证据闭合律（Evidence Closure Law） — 白皮书 §4.1
 *
 * > 任何 AI 对外的事实性陈述必须可追溯到证据来源。无证据即无输出。
 *
 * 工程归约：
 *   - 候选 action 的 minimum_evidence_level 必须 ≤ 实际 evidence_level
 *   - 仅 user_assertion 不能支撑 minimum_evidence_level ≥ 3 的 action
 *   - 若 action 要求 verifier_result 但 evidence 还在 pending_verification → violated
 *
 * 律内核：
 *   - 不调 LLM、不查 KB、不触发 verifier —— 所有判断基于已绑定的 EvidencePack
 *   - 输入参数纯粹；不持有任何 tenant 状态
 */

import type { EvidencePack, EvidenceBinding, EvidenceLevel } from '../../binder/EvidenceBinder';
import type { CandidateAction } from '../../builder/CandidatePackBuilder';
import type { Claim, ClaimType } from '../../extractor/ClaimExtractor';

export interface EvidenceLawResult {
  readonly violated: boolean;
  readonly reason: string;
  readonly violating_action_type?: string;
  readonly required_evidence_level?: EvidenceLevel;
  readonly actual_evidence_level?: EvidenceLevel;
  readonly pending_action_types?: ReadonlyArray<string>;
}

export class EvidenceLaw {
  /**
   * 评估每条候选动作所对应主张是否具备最低证据等级。
   * 返回第一条违律即可——后续 hold 流程足以阻断输出。
   */
  evaluate(
    claims: ReadonlyArray<Claim>,
    evidence_pack: EvidencePack,
    candidate_actions: ReadonlyArray<CandidateAction>,
  ): EvidenceLawResult {
    const pending_action_types: string[] = [];

    for (const action of candidate_actions) {
      const sourceClaims = claims.filter(c =>
        action.source_claim_types.includes(c.type as ClaimType),
      );
      if (sourceClaims.length === 0) continue;

      // 找该 action 触发主张里"证据等级最高"的那条
      const sourceBindings = evidence_pack.bindings.filter(b =>
        action.source_claim_types.includes(b.claim.type as ClaimType),
      );
      const actualLevel = highestLevel(sourceBindings);
      const required = action.minimum_evidence_level;

      // 任一相关 binding 还在 pending_verification → action 暂不可决
      const anyPendingVerify = sourceBindings.some(
        b => b.pending && b.pending_reason === 'pending_verification',
      );
      if (anyPendingVerify) {
        pending_action_types.push(action.action_type);
        continue;        // 不立即 violated，后续律 2 / 上层走 verifier 流程
      }

      if (actualLevel < required) {
        return Object.freeze({
          violated: true,
          reason: `evidence_below_threshold:${action.action_type}`,
          violating_action_type: action.action_type,
          required_evidence_level: required as EvidenceLevel,
          actual_evidence_level: actualLevel,
        });
      }
    }

    return Object.freeze({
      violated: false,
      reason: pending_action_types.length > 0 ? 'pending_verification' : 'ok',
      pending_action_types: Object.freeze(pending_action_types),
    });
  }
}

function highestLevel(bs: ReadonlyArray<EvidenceBinding>): EvidenceLevel {
  let max: EvidenceLevel = 1;
  for (const b of bs) if (b.evidence_level > max) max = b.evidence_level;
  return max;
}
