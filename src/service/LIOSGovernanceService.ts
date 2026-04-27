/**
 * LIOSGovernanceService — v2.2 无状态治理决策服务（α-3 完整实现）。
 *
 * 严格遵循《拆分边界书 v0.1》§1：
 *   - 不持有任何成员变量
 *   - 不读 ledger
 *   - 不写 ledger
 *   - 不维护 session 状态
 *   - 但接收 projection_snapshot 作为参数（律 2 累计的"读"侧）
 *
 * 同样的 (req) → 同样的 result（在外部依赖 LLM/KB 同等条件下）。
 *
 * verifier 完全外移到调用方（candidate C）：
 *   - 调用方（如 ConversationRuntime）抽 claims → 看 order.query → 调 verifier
 *   - 把 verifier 结果包装为 ExternalEvidence 通过 req 传入
 *   - 本服务从 req.external_evidence 提取 verifier 信号，不持有 verifier 实例
 */

import { randomUUID, createHash } from 'node:crypto';
import { ClaimExtractor } from '../extractor/ClaimExtractor';
import type { Claim } from '../extractor/ClaimExtractor';
import { EvidenceBinder } from '../binder/EvidenceBinder';
import type { EvidencePack } from '../binder/EvidenceBinder';
import { CandidatePackBuilder } from '../builder/CandidatePackBuilder';
import type { KernelInput } from '../builder/CandidatePackBuilder';
import { LIKernel } from '../kernel/v2_1/LIKernel';
import type { Decision } from '../kernel/v2_1/LIKernel';
import { ActionResolver } from '../resolver/ActionResolver';
import type { ResolvedAction } from '../resolver/ActionResolver';
import { BoundedLLMGenerator } from '../generator/BoundedLLMGenerator';
import { BoundsAuditor } from '../auditor/BoundsAuditor';
import type { AuditResult } from '../auditor/BoundsAuditor';
import type { ConversationProjection } from '../runtime/ConversationProjection';
import { getKBSnapshot } from '../services/kbCorpus';

import type {
  DecideRequest,
  DecideResult,
  ExternalEvidence,
  LedgerPayload,
  PreKernelBridge,
  ProjectionSnapshot,
  ResolvedActionLite,
} from './types';

import {
  pickDominantFamilyForTurn,
  inferActiveTrack,
  detectUnknownProduct,
  augmentDecisionForUnknownProduct,
  augmentDecisionFromExternalEvidence,
  upgradeInquiryEvidence,
  upgradeOrderEvidence,
  retrieveKBSnippets,
  fetchHistoryBrief,
  mapVerdictToLegacy,
  synthesizeScope,
  synthesizeInstruction,
  synthesizeClaimVerificationStatus,
  normalizeClaimForLegacy,
  extractIdentifiers,
} from './decision-helpers';

// 让 createHash 不被未引用警告剔除（v2.1 兼容残留）
void createHash;

// ─────────────────────────────────────────────────────────────────────────────
// 服务
// ─────────────────────────────────────────────────────────────────────────────

export class LIOSGovernanceService {
  // ⚠️ 不持有任何 ledger / projection 实例字段（边界书 §1.2 / §3.3）
  // 内置组件均为纯函数 / 自治组件
  private readonly extractor = new ClaimExtractor();
  private readonly binder = new EvidenceBinder();
  private readonly builder = new CandidatePackBuilder();
  private readonly kernel = new LIKernel();
  private readonly resolver = new ActionResolver();
  private readonly generator = new BoundedLLMGenerator();
  private readonly auditor = new BoundsAuditor();

  /**
   * 主决策入口。无状态（同 req 同 result，在 LLM 取样温度允许的范围内）。
   *
   * 流程（边界书 §2 + α-3 候选 C）：
   *   1) 提取 claims（应用层若已抽好通过 pre_extracted_claims 传入则跳过）
   *   2) 绑定证据（含 KB 召回升级 + ExternalEvidence 中 verifier 升级）
   *   3) 构造 KernelInput（含 projection 重建自 snapshot）
   *   4) LIKernel 裁决（律 1 + 律 2，projection 入参）
   *   5) ActionResolver compute（不写 ledger）
   *   6) BoundedLLMGenerator 生成 reply_draft
   *   7) augmentDecision* 应用（基于 ExternalEvidence / 未知商品）
   *   8) BoundsAuditor 三层审核 + retry（整体原子）
   *   9) 计算 LedgerPayload（含 pre_kernel_bridge 兼容字段）
   *  10) 返回 DecideResult
   */
  async decide(req: DecideRequest): Promise<DecideResult> {
    const traceId = req.trace_id ?? generateTraceId();

    // 重建 projection（snapshot → ConversationProjection 接口形态）
    const projection = projectionFromSnapshot(req.projection_snapshot);

    // Step 1: claims（优先用 pre_extracted_claims）
    const claims = req.pre_extracted_claims
      ? [...req.pre_extracted_claims]
      : await this.extractor.extract(req.user_message, {
          last_system_question: projection.last_system_question,
          active_track: inferActiveTrack(projection),
          tenant_id: req.tenant_id,
          trace_id: traceId,
        });

    // Step 2: evidence binding（基础）
    const kbSnap = await getKBSnapshot(req.tenant_id).catch(() => ({
      productNames: [] as string[],
      kbCorpus: '',
    }));
    let evidencePack: EvidencePack = this.binder.bind(claims, {
      kbProductNames: kbSnap.productNames,
      tenant_id: req.tenant_id,
      ledgerHasPriorPurchase: projection.committed_actions.some(
        a => a.action_type === 'purchase.confirmed',
      ),
    });

    // Step 2.1: KB 召回 → 升级 inquiry.* 类 binding
    const kbSnippetsEarly = await retrieveKBSnippets(req.tenant_id, req.user_message);
    if (kbSnippetsEarly.length > 0) {
      evidencePack = upgradeInquiryEvidence(evidencePack, kbSnippetsEarly);
    }

    // Step 2.2: 从 ExternalEvidence 提取 verifier 信号 → 升级 order.query 证据
    const verifierInfo = extractVerifierFromExternalEvidence(req.external_evidence ?? []);
    if (verifierInfo) {
      evidencePack = upgradeOrderEvidence(
        evidencePack,
        verifierInfo.order_id,
        verifierInfo.classification,
      );
    }

    // Step 3: KernelInput
    const kernelInput: KernelInput = this.builder.build({
      conversation_id: req.session_id,
      tenant_id: req.tenant_id,
      claims,
      evidence_pack: evidencePack,
      projection,
    });

    // Step 4: LIKernel 裁决
    const decision: Decision = this.kernel.decide(kernelInput);

    // Step 5: ActionResolver compute（不写 ledger，只 resolve action_id + 查 already_committed）
    const resolved: ResolvedAction[] = await this.resolver.resolve(decision.chosen_actions, {
      tenant_id: req.tenant_id,
      conversation_id: req.session_id,
      user_input: req.user_message,
      channel: req.channel,
    });
    const alreadyCommittedHandoff = resolved.find(
      a => a.action_type === 'handoff.transfer' && a.already_committed,
    );

    // Step 6: KB snippets + history（为 generator 准备上下文）
    let kbSnippets = await retrieveKBSnippets(req.tenant_id, req.user_message);
    if (verifierInfo?.summary) {
      kbSnippets = [`【订单核验上下文】${verifierInfo.summary}`, ...kbSnippets];
    }
    const historyBrief = await fetchHistoryBrief(req.session_id, req.tenant_id, 4);

    // Step 7: augment decision
    let decisionForGen: Decision = decision;
    if ((req.external_evidence ?? []).length > 0) {
      decisionForGen = augmentDecisionFromExternalEvidence(
        decisionForGen,
        req.external_evidence ?? [],
      );
    }
    const unknownProductMentioned = detectUnknownProduct(claims, kbSnippets);
    if (unknownProductMentioned && decisionForGen.verdict === 'hold') {
      decisionForGen = augmentDecisionForUnknownProduct(decisionForGen, unknownProductMentioned);
    }

    // Step 8: 生成 reply_draft
    const genResult = await this.generator.generate({
      user_input: req.user_message,
      decision: decisionForGen,
      projection,
      kb_snippets: kbSnippets,
      history_brief: historyBrief,
      tenant_id: req.tenant_id,
      trace_id: traceId,
      language: (req.language as 'zh-TW' | 'zh-CN' | 'en') ?? 'zh-TW',
    });

    // Step 9: BoundsAuditor 三层 + retry（原子）
    const audited: AuditResult = await this.auditor.audit(
      { reply: genResult.reply, decision: decisionForGen },
      async () => {
        const r = await this.generator.generate({
          user_input: req.user_message,
          decision: decisionForGen,
          projection,
          kb_snippets: kbSnippets,
          history_brief: historyBrief,
          tenant_id: req.tenant_id,
          trace_id: traceId,
          language: (req.language as 'zh-TW' | 'zh-CN' | 'en') ?? 'zh-TW',
        });
        return r.reply;
      },
    );

    // Step 10: 组装 LedgerPayload（让调用方写完整 ledger）
    const projectionAlreadyDissatisfied = !!projection.attempts['family:dissatisfaction_track'];
    const dominantFamily = pickDominantFamilyForTurn({
      decision,
      claims,
      projection_already_dissatisfied: projectionAlreadyDissatisfied,
    });

    const verdictLegacy = mapVerdictToLegacy(
      decision,
      !!alreadyCommittedHandoff,
      verifierInfo?.classification ?? null,
    );

    const bridgeArgs = {
      claims,
      evidence_pack: evidencePack,
      decision,
      verifier_classification: verifierInfo?.classification ?? null,
      verifier_order_id: verifierInfo?.order_id ?? null,
    };
    const scope = synthesizeScope(bridgeArgs);
    const instruction = synthesizeInstruction(decision);
    const attempts = decision.law2.repeated_pending?.[0]?.count ?? 1;
    const secondPassVerdict = verifierInfo ? verdictLegacy : null;

    const preKernelBridge: PreKernelBridge = Object.freeze({
      source: 'unified_llm_v3_pre_kernel' as const,
      pre_verdict:               verdictLegacy,
      pre_reason:                decision.reason,
      pre_scope:                 Object.freeze(scope),
      pre_instruction:           instruction,
      attempts,
      attempt_log:               Object.freeze([]),
      user_claims_extracted:     Object.freeze(claims.map(c => normalizeClaimForLegacy(c))),
      claims_verification_status: Object.freeze(synthesizeClaimVerificationStatus(evidencePack)),
      channel:                   req.channel ?? 'demo',
      extracted_identifiers:     Object.freeze(extractIdentifiers(claims)),
      verifications_performed:   Object.freeze(
        verifierInfo
          ? [{ result: verifierInfo.classification, order_id: verifierInfo.order_id }]
          : [],
      ),
      second_pass_verdict:       secondPassVerdict,
      second_pass_scope:         verifierInfo ? Object.freeze(scope) : null,
      extracted_order_source:    null,
      is_pure_affirmation:       claims.some(c => c.type === 'meta.confirmation'),
    });

    const actionsToStage: ResolvedActionLite[] = resolved.map(r => Object.freeze({
      action_id: r.action_id,
      action_type: r.action_type,
      idempotency_scope: r.idempotency_scope,
      already_committed: r.already_committed,
      ...(r.target_object_id ? { target_object_id: r.target_object_id } : {}),
    }));

    const ledgerPayload: LedgerPayload = Object.freeze({
      dominant_family: dominantFamily,
      turn_family: dominantFamily,
      audit_layer: audited.layer,
      audit_retried: !!audited.retried,
      order_verifier_summary: verifierInfo?.summary ?? null,
      order_verifier_classification: verifierInfo?.classification ?? null,
      order_verifier_id: verifierInfo?.order_id ?? null,
      pre_kernel_bridge: preKernelBridge,
      actions_to_stage: Object.freeze(actionsToStage),
      structured: Object.freeze({
        runtime: 'v2_1',
        verdict: decision.verdict,
        reason: decision.reason,
        chosen_actions: decision.chosen_actions.map(c => c.action_type),
        verifier_summary: verifierInfo?.summary ?? null,
        audit_layer: audited.layer,
        audit_retried: !!audited.retried,
        attempt_key: dominantFamily !== 'unknown' ? `family:${dominantFamily}` : undefined,
        turn_family: dominantFamily,
      }),
    });

    return Object.freeze({
      // 注意：返回 augment 后的（decisionForGen）—— 让调用方看到 verifier /
      // unknown-product 增强后的 verdict / bounds，与 generator/auditor 实际用的一致
      verdict: decisionForGen.verdict,
      verdict_legacy: verdictLegacy,
      reason: decisionForGen.reason,
      bounds: Object.freeze({
        must:     [...decisionForGen.bounds.must],
        must_not: [...decisionForGen.bounds.must_not],
        may:      [...decisionForGen.bounds.may],
      }),
      reply_draft: audited.final_text,
      should_escalate: !!decision.should_escalate,
      ledger_payload: ledgerPayload,
      trace_id: traceId,
      pipeline: Object.freeze({
        runtime:           'v2_1',
        kernel_verdict:    decisionForGen.verdict,
        kernel_reason:     decisionForGen.reason,
        bounds_must:       [...decisionForGen.bounds.must],
        bounds_must_not:   [...decisionForGen.bounds.must_not],
        claims_extracted:  claims.map(c => c.type),
        evidence_levels:   evidencePack.bindings.map(b => b.evidence_level),
        verifier_class:    verifierInfo?.classification ?? null,
        audit_layer:       audited.layer,
        audit_retried:     !!audited.retried,
        actions_resolved:  resolved.map(r => ({
          action_id:        r.action_id,
          action_type:      r.action_type,
          already_committed: r.already_committed,
        })),
      }),
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// helpers（service-internal，不导出）
// ─────────────────────────────────────────────────────────────────────────────

function generateTraceId(): string {
  return randomUUID();
}

interface VerifierInfoFromEvidence {
  classification: string;
  order_id: string;
  summary: string | null;
}

function extractVerifierFromExternalEvidence(
  evidence: ReadonlyArray<ExternalEvidence>,
): VerifierInfoFromEvidence | null {
  const e = evidence.find(
    x => x.source === 'mock_order_verifier' && x.type === 'order_verification',
  );
  if (!e) return null;
  const data = e.data as Record<string, unknown>;
  const classification = typeof data.classification === 'string' ? data.classification : null;
  const order_id = typeof data.order_id === 'string' ? data.order_id : null;
  const summary = typeof data.summary === 'string' ? data.summary : null;
  if (!classification || !order_id) return null;
  return { classification, order_id, summary };
}

/**
 * 从 ProjectionSnapshot 重建 ConversationProjection 的 readonly 视图。
 *
 * 边界书 §4.2 不变量：snapshot 必须能重构出 LIKernel 需要的全部 projection 字段。
 * 当 snapshot 缺失（如首轮 / 直接 HTTP API 调用方未持 projection）→ 用空 projection。
 */
function projectionFromSnapshot(snapshot: ProjectionSnapshot | undefined): ConversationProjection {
  // 简化实现：直接构造一个对象，字段用 snapshot 或默认空值
  // 这里不调 ConversationProjection.empty() 是因为后者构造一个新实例需要 conversation_id/tenant_id
  // 而 projection_snapshot 自己已含字段，可作为 readonly 视图直接使用
  if (!snapshot) {
    return Object.freeze({
      conversation_id: '',
      tenant_id: '',
      inferred_phase: 'fresh',
      pending_slots: Object.freeze([]),
      filled_slots: Object.freeze([]),
      pending_actions: Object.freeze([]),
      committed_actions: Object.freeze([]),
      attempts: Object.freeze({}),
      verification_history: Object.freeze([]),
      last_system_question: null,
      computed_from_ledger_seq: 0,
      computed_at: Date.now(),
      // ConversationProjection 类的方法（snapshot/appendEntry）此处用不到——
      // service 仅读 projection 字段
      snapshot: () => ({}) as never,
      appendEntry: () => ({}) as never,
    } as unknown as ConversationProjection);
  }
  // ProjectionSnapshot 的字段对齐 ConversationProjectionShape
  return snapshot as unknown as ConversationProjection;
}

// 单例
export const liosGovernanceService = new LIOSGovernanceService();
