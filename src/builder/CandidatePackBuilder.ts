/**
 * CandidatePackBuilder —— 把零散输入拼成 KernelInput（白皮书 §5.5）
 *
 * 输入：claims + evidence_pack + projection + tenant_id + ledger_summary
 * 输出：标准 KernelInput（含 candidate_actions 与 tenant_policy）
 *
 * 职责：
 *   - 加载 TenantPolicy（按 tenant_id）
 *   - 根据 policy.candidate_action_templates 与 claims 派生 candidate_actions
 *   - 不做裁决；不计算 action_id（T7 ActionResolver 负责）
 *
 * 严格不做（施工方案 T5）：
 *   - 不把 Policy 内容写进 Kernel
 *   - 不让 Kernel 知道任何具体租户
 */

import type { Claim, ClaimType } from '../extractor/ClaimExtractor';
import type { EvidencePack } from '../binder/EvidenceBinder';
import type { TenantPolicy, CandidateActionTemplate, IdempotencyScope } from '../policy/TenantPolicy';
import { loadTenantPolicy } from '../policy/TenantPolicy';
import type { ConversationProjection, LedgerSummary } from '../runtime/ConversationProjection';

// ─────────────────────────────────────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────────────────────────────────────

export interface CandidateAction {
  readonly action_type: string;
  readonly idempotency_scope: IdempotencyScope;
  readonly required_slots: ReadonlyArray<string>;
  readonly minimum_evidence_level: number;
  readonly source_claim_types: ReadonlyArray<ClaimType>;
  readonly target_object_id?: string;       // 如 order_id —— 用于 ActionResolver 生成 ID
  readonly normalized_claims: ReadonlyArray<Readonly<Record<string, unknown>>>;
}

export interface KernelInput {
  readonly conversation_id: string;
  readonly tenant_id: string;
  readonly claims: ReadonlyArray<Claim>;
  readonly evidence_pack: EvidencePack;
  readonly candidate_actions: ReadonlyArray<CandidateAction>;
  readonly tenant_policy: TenantPolicy;
  readonly projection: ConversationProjection | null;
  readonly ledger_summary: LedgerSummary | null;
}

export interface BuildInput {
  readonly conversation_id: string;
  readonly tenant_id: string;
  readonly claims: ReadonlyArray<Claim>;
  readonly evidence_pack: EvidencePack;
  readonly projection?: ConversationProjection | null;
  readonly ledger_summary?: LedgerSummary | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// CandidatePackBuilder
// ─────────────────────────────────────────────────────────────────────────────

export class CandidatePackBuilder {
  build(input: BuildInput): KernelInput {
    const policy = loadTenantPolicy(input.tenant_id);
    const candidate_actions = deriveCandidateActions(input.claims, policy);

    return Object.freeze({
      conversation_id:   input.conversation_id,
      tenant_id:         input.tenant_id,
      claims:            input.claims,
      evidence_pack:     input.evidence_pack,
      candidate_actions: Object.freeze(candidate_actions),
      tenant_policy:     policy,
      projection:        input.projection ?? null,
      ledger_summary:    input.ledger_summary ?? null,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 候选动作派生
// ─────────────────────────────────────────────────────────────────────────────

function deriveCandidateActions(
  claims: ReadonlyArray<Claim>,
  policy: TenantPolicy,
): CandidateAction[] {
  const out: CandidateAction[] = [];
  const claimTypes = new Set<ClaimType>(claims.map(c => c.type));

  for (const tpl of policy.candidate_action_templates) {
    const matchedTypes = tpl.derived_from_claim_types.filter(t => claimTypes.has(t));
    if (matchedTypes.length === 0) continue;

    const matchedClaims = claims.filter(c => matchedTypes.includes(c.type));
    const target_object_id = pickTargetObject(tpl, matchedClaims);

    out.push(Object.freeze({
      action_type:           tpl.action_type,
      idempotency_scope:     tpl.idempotency_scope,
      required_slots:        tpl.required_slots,
      minimum_evidence_level: tpl.minimum_evidence_level ?? 1,
      source_claim_types:    Object.freeze([...matchedTypes]),
      ...(target_object_id ? { target_object_id } : {}),
      normalized_claims: Object.freeze(
        matchedClaims.map(normalizeClaim),
      ),
    }));
  }

  return out;
}

function pickTargetObject(
  tpl: CandidateActionTemplate,
  matchedClaims: ReadonlyArray<Claim>,
): string | undefined {
  // 一般以 order_id 作为 target_object_id 锚点（T7 用于 hash）
  for (const c of matchedClaims) {
    const order_id = (c.content as { order_id?: unknown }).order_id;
    if (typeof order_id === 'string' && order_id.length > 0) return order_id;
  }
  // capability / handoff 类没有 target_object_id
  return undefined;
}

function normalizeClaim(c: Claim): Readonly<Record<string, unknown>> {
  // 只保留语义关键字段，去掉 confidence 等运行期值，便于 T7 稳定 hash
  return Object.freeze({
    type: c.type,
    content: Object.freeze({ ...(c.content as Record<string, unknown>) }),
    ...(c.target ? { target: c.target } : {}),
  });
}

// 单例
export const candidatePackBuilder = new CandidatePackBuilder();
