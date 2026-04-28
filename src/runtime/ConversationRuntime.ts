/**
 * ConversationRuntime —— v2.2 编排层（α-3 改造后）。
 *
 * 职责（《拆分边界书 v0.1》§1.3）：
 *   - 维护当前 session 的 projection（律 2 family-track 累计的载体）
 *   - 接收用户输入
 *   - 在 decide 之前抽 claims + 调 verifier（candidate C），包装 ExternalEvidence
 *   - 把 (input, projection_snapshot, external_evidence) 传给 LIOSGovernanceService.decide()
 *   - 拿到 result 后写完整的 9 列 ledger + 桥接行 + actions stagePending
 *   - 更新 projection（律 2 累计写入端）
 *   - 渲染回复给用户
 *
 * 治理决策计算 → 全部搬到 LIOSGovernanceService（src/service/）。
 * 决策 helpers → 搬到 src/service/decision-helpers.ts。
 *
 * 灰度：chat.ts 顶部 LIOS_RUNTIME=v2_1 feature flag 切入。
 */

import { randomUUID } from 'node:crypto';
import { query } from '../db/client';
import { ClaimExtractor } from '../extractor/ClaimExtractor';
import type { Claim } from '../extractor/ClaimExtractor';
import { ProjectionRepo } from './ProjectionRepo';
import { createEscalationSession } from '../services/agentSession';
import type { ConversationProjection } from './ConversationProjection';
import { mockOrderVerifier } from '../verifiers/MockOrderVerifier';
import { summarizeVerification } from '../verifiers/types';
import type { LiosIntent } from '../types/lios';

import { LIOSGovernanceService } from '../service/LIOSGovernanceService';
import type {
  DecideRequest,
  DecideResult,
  ExternalEvidence,
  LedgerPayload,
} from '../service/types';

// ─────────────────────────────────────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────────────────────────────────────

export interface RuntimeRequest {
  readonly tenant_id: string;
  readonly session_id: string;
  readonly message: string;
  readonly lang?: string;
  readonly user_id?: string;
  readonly channel?: string;
}

export interface RuntimeResponse {
  readonly reply: string;
  readonly quick_replies: ReadonlyArray<string>;
  readonly trace_id: string;
  readonly verdict_legacy: -2 | -1 | 0 | 1;
  readonly verdict_new: 'accept' | 'hold' | 'reject';
  readonly should_escalate: boolean;
  readonly handoff_context?: HandoffContext;
  readonly pipeline: Readonly<Record<string, unknown>>;
}

/**
 * v2.1 转人工上下文（OI-005 修 1 扩展业务核心字段）。
 * 字段缺失时显式标 "missing" 字面值，agent UI 能区分"未发生"与"未提取"。
 */
export interface HandoffContext {
  readonly user_original_complaint: string;
  readonly product_name: string | 'missing';
  readonly product_condition: string | 'missing';
  readonly order_id: string | 'missing';
  readonly reason: string | 'missing';
  readonly verdict_trajectory: ReadonlyArray<string>;
  readonly collected_verification: ReadonlyArray<Record<string, unknown>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// 主控
// ─────────────────────────────────────────────────────────────────────────────

export class ConversationRuntime {
  private readonly governanceService: LIOSGovernanceService;

  /**
   * γ-3：service 必填注入（与 LIOSGovernanceService.constructor 同模式）。
   * 由 src/index.ts 启动时 `new ConversationRuntime(service)` 一次，
   * 通过 setConversationRuntime 注入给路由层（chat.ts 等）使用。
   */
  constructor(governanceService: LIOSGovernanceService) {
    this.governanceService = governanceService;
  }
  private readonly projectionRepo = new ProjectionRepo();
  // claim 抽取：在 decide 之前需要它来检测 order.query
  // 这是 verifier 候选 C 的代价：runtime 必须自己先抽一次 claim
  // 抽到的结果通过 DecideRequest.pre_extracted_claims 传给 service，避免 service 内重复抽
  private readonly extractor = new ClaimExtractor();

  async handle(req: RuntimeRequest): Promise<RuntimeResponse> {
    const { tenant_id, session_id, message } = req;

    // Step 0: 创建 intent（兼容现有 lios_intents 表 + 给 ledger 写入用 trace_id）
    const [intent] = await query<LiosIntent>(
      `INSERT INTO lios_intents
         (tenant_id, session_id, raw_input, parsed_goal, status)
       VALUES ($1, $2, $3, $4, 'processing')
       RETURNING *`,
      [tenant_id, session_id, message, JSON.stringify({ runtime: 'v2_1' })],
    );

    // Step 1: 加载 projection（律 2 累计的载体）
    const projection: ConversationProjection = await this.projectionRepo.forceRebuild(
      session_id,
      tenant_id,
    );

    // Step 2: 抽 claims（runtime 自抽——为了在 decide 前判断要不要调 verifier）
    const claims = await this.extractor.extract(message, {
      last_system_question: projection.last_system_question,
      tenant_id,
      trace_id: intent.trace_id,
    });

    // Step 3: 若 claim 含 order.query → 调 verifier → 包装 ExternalEvidence
    const externalEvidence: ExternalEvidence[] = [];
    let verifierClassification: string | null = null;
    let verifierOrderId: string | null = null;
    let verifierSummary: string | null = null;

    const orderClaim = claims.find(c => c.type === 'order.query');
    if (orderClaim) {
      const oid = (orderClaim.content as { order_id?: unknown }).order_id;
      if (typeof oid === 'string' && oid.length > 0) {
        try {
          const v = await mockOrderVerifier.verifyByOrderId(oid, {
            tenant_id, shop_id: tenant_id,
          });
          verifierClassification = v.classification;
          verifierOrderId = oid;
          verifierSummary = summarizeVerification(v);
          externalEvidence.push({
            source: 'mock_order_verifier',
            type: 'order_verification',
            data: {
              classification: v.classification,
              order_id: oid,
              summary: verifierSummary,
              raw: v as unknown as Record<string, unknown>,
            },
            confidence: 1.0,
            anchor: `mock_order:${oid}`,
          });
        } catch { /* verifier 不可用 → 不传 ExternalEvidence；service 内仍按 pending_verification 处理 */ }
      }
    }

    // Step 4: 调 LIOSGovernanceService.decide()
    const decideReq: DecideRequest = {
      tenant_id,
      source_app: 'conversation_runtime',
      session_id,
      user_message: message,
      language: (req.lang as 'zh' | 'th' | 'en' | 'auto') ?? 'auto',
      pre_extracted_claims: claims,
      external_evidence: externalEvidence,
      projection_snapshot: projection as unknown as DecideRequest['projection_snapshot'],
      trace_id: intent.trace_id,
      channel: req.channel,
    };

    const result: DecideResult = await this.governanceService.decide(decideReq);

    // Step 5: 写 ledger（用 result.ledger_payload）
    await persistTurnToLedger({
      intent_id: intent.id,
      tenant_id,
      conversation_id: session_id,
      claims,
      decision_verdict: result.verdict,
      decision_reason: result.reason,
      decision_bounds: {
        must:     [...result.bounds.must],
        must_not: [...result.bounds.must_not],
        may:      [...result.bounds.may],
      },
      ledger_payload: result.ledger_payload,
    });

    // Step 6: stagePending actions（律 2 未命中的新 action 入账本 pending）
    for (const action of result.ledger_payload.actions_to_stage) {
      if (!action.already_committed) {
        await stagePendingAction({
          action_id: action.action_id,
          action_type: action.action_type,
          tenant_id,
          conversation_id: session_id,
        }).catch(() => {});
      }
    }

    // Step 7: 关闭 intent
    await query(
      `UPDATE lios_intents SET status=$1, updated_at=NOW() WHERE id=$2`,
      ['completed', intent.id],
    ).catch(() => {});

    // Step 8: handoff_context 构造（read ledger）+ createEscalationSession
    const handoffContext = (result.should_escalate || result.verdict_legacy === -2)
      ? await buildHandoffContextFromLedger(session_id, tenant_id, message, verifierSummary)
      : undefined;

    if (handoffContext && result.verdict_legacy === -2) {
      await createEscalationSession({
        tenant_id, session_id,
        intent_id: intent.id,
        user_message: message,
        lios_reply: result.reply_draft,
        reject_reason: result.reason,
        handoff_context: handoffContext as unknown as Record<string, unknown>,
      }).catch(err => console.error('[runtime] createEscalationSession failed:', err));
    }

    // 让 verifierClassification / verifierOrderId 保持引用（debug 用，避免 lint 误删）
    void verifierClassification;
    void verifierOrderId;

    // Step 9: 返回 RuntimeResponse
    return Object.freeze({
      reply: result.reply_draft,
      quick_replies: ['查詢訂單狀態', '退換貨申請', '商品詳情諮詢', '人工客服'],
      trace_id: intent.trace_id,
      verdict_legacy: result.verdict_legacy,
      verdict_new: result.verdict,
      should_escalate: result.should_escalate,
      ...(handoffContext ? { handoff_context: handoffContext } : {}),
      pipeline: result.pipeline ?? Object.freeze({}),
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Ledger 写入（保留在 ConversationRuntime —— 编排层职责）
// ─────────────────────────────────────────────────────────────────────────────

interface PersistArgs {
  intent_id: string;
  tenant_id: string;
  conversation_id: string;
  claims: ReadonlyArray<Claim>;
  decision_verdict: 'accept' | 'hold' | 'reject';
  decision_reason: string;
  decision_bounds: { must: string[]; must_not: string[]; may: string[] };
  ledger_payload: LedgerPayload;
}

async function persistTurnToLedger(a: PersistArgs): Promise<void> {
  const lp = a.ledger_payload;

  // a) v2.1 结构化行：写 kernel.scored 行
  const turnEntityId = randomUUID();
  await query(
    `INSERT INTO lios_ledgers
       (entity_type, entity_id, event_type, payload, tenant_id,
        conversation_id, claims, evidence_pack, bounds, action_id, action_status)
     VALUES
       ('intent', $1, 'kernel.scored', $2, $3, $4, $5, $6, $7, NULL, NULL)`,
    [
      turnEntityId,
      JSON.stringify(lp.structured),
      a.tenant_id,
      a.conversation_id,
      JSON.stringify(a.claims),
      // evidence_pack 列：v2.1 写 binder 输出的完整结构。α-3 后由 service 算，但
      // 这里没单独透出 evidence_pack；用 ledger_payload 里压缩的字段无完整还原。
      // 折中：写一个简化对象（仍能让 ProjectionRepo 重建 dominant_family 等）。
      JSON.stringify({
        verifier_classification: lp.order_verifier_classification,
        verifier_order_id: lp.order_verifier_id,
      }),
      JSON.stringify(a.decision_bounds),
    ],
  ).catch(err => { console.error('[runtime] write structured ledger failed:', err); });

  // b) 兼容旧 runner：source='unified_llm_v3_pre_kernel'
  const legacyDecisionId = randomUUID();
  const [pack] = await query<{ id: string }>(
    `INSERT INTO lios_candidate_packs
       (intent_id, tenant_id, name, description, score, state, source_type, metadata)
     VALUES ($1, $2, 'v2.1-runtime-pack', '', 0.9, '1', 'v2_1_runtime', '{}')
     RETURNING id`,
    [a.intent_id, a.tenant_id],
  );
  await query(
    `INSERT INTO lios_decisions
       (id, intent_id, pack_id, tenant_id, decision_type, rationale, confidence, hold_count, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8)`,
    [
      legacyDecisionId, a.intent_id, pack.id, a.tenant_id,
      a.decision_verdict,           // 'accept' | 'hold' | 'reject'
      a.decision_reason,
      0.9,
      JSON.stringify({ runtime: 'v2_1' }),
    ],
  );
  const legacyActionId = randomUUID();
  await query(
    `INSERT INTO lios_actions
       (id, decision_id, tenant_id, action_type, payload, status, idempotency_key)
     VALUES ($1, $2, $3, 'v2_1_action', '{}', 'done', $4)`,
    [legacyActionId, legacyDecisionId, a.tenant_id, `v21-${legacyActionId.slice(0, 8)}`],
  );

  // 桥接行（runner 查询的就是这条）
  await query(
    `INSERT INTO lios_ledgers
       (entity_type, entity_id, event_type, payload, tenant_id, conversation_id)
     VALUES ('action', $1, 'action.created', $2, $3, $4)`,
    [
      legacyActionId,
      JSON.stringify(lp.pre_kernel_bridge),
      a.tenant_id,
      a.conversation_id,
    ],
  );
}

async function stagePendingAction(args: {
  action_id: string;
  action_type: string;
  tenant_id: string;
  conversation_id: string;
}): Promise<void> {
  await query(
    `INSERT INTO lios_ledgers
      (entity_type, entity_id, event_type, payload, tenant_id,
       conversation_id, action_id, action_status)
     VALUES
      ('action', gen_random_uuid(), 'action.created',
       $1, $2, $3, $4, 'pending')`,
    [
      JSON.stringify({ action_type: args.action_type, source: 'conversation_runtime' }),
      args.tenant_id,
      args.conversation_id,
      args.action_id,
    ],
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// HandoffContext 构造（读 ledger —— 编排层 IO）
// ─────────────────────────────────────────────────────────────────────────────

async function buildHandoffContextFromLedger(
  conversation_id: string,
  tenant_id: string,
  current_user_input: string,
  current_verifier_summary: string | null,
): Promise<HandoffContext> {
  const rows = await query<{
    payload: { verdict?: string; verifier_summary?: string | null; reason?: string };
    claims:  unknown;
  }>(
    `SELECT payload, claims
     FROM   lios_ledgers
     WHERE  conversation_id = $1
       AND  tenant_id       = $2
       AND  event_type      = 'kernel.scored'
       AND  payload->>'runtime' = 'v2_1'
     ORDER  BY seq ASC`,
    [conversation_id, tenant_id],
  ).catch(() => []);

  const userInputRows = await query<{ raw_input: string; created_at: string }>(
    `SELECT raw_input, created_at
     FROM   lios_intents
     WHERE  session_id = $1 AND tenant_id = $2
     ORDER  BY created_at ASC`,
    [conversation_id, tenant_id],
  ).catch(() => []);

  const verdictTrajectory: string[] = rows.map(r =>
    (r.payload?.verdict as string) ?? 'unknown',
  );
  if (verdictTrajectory.length === 0 || verdictTrajectory[verdictTrajectory.length - 1] !== 'escalate') {
    verdictTrajectory.push('escalate');
  }

  const collected: Array<Record<string, unknown>> = [];
  for (const r of rows) {
    if (r.payload?.verifier_summary) {
      collected.push({ verifier: r.payload.verifier_summary });
    }
  }
  if (current_verifier_summary && !collected.some(c => c.verifier === current_verifier_summary)) {
    collected.push({ verifier: current_verifier_summary });
  }
  if (collected.length === 0) {
    collected.push({ trigger: 'family_threshold_reached', collected_at: new Date().toISOString() });
  }

  // 业务核心字段聚合（OI-005 修 1）
  const allClaims: Array<Record<string, unknown>> = [];
  for (const r of rows) {
    if (Array.isArray(r.claims)) {
      for (const c of r.claims) {
        if (c && typeof c === 'object') allClaims.push(c as Record<string, unknown>);
      }
    }
  }

  const aggregateField = (
    candidateFields: ReadonlyArray<string>,
    onlyFromTypes?: ReadonlyArray<string>,
  ): string | 'missing' => {
    for (let i = 0; i < allClaims.length; i++) {
      const c = allClaims[i];
      const t = c.type as string | undefined;
      if (onlyFromTypes && (typeof t !== 'string' || !onlyFromTypes.includes(t))) continue;
      const content = (c.content as Record<string, unknown> | undefined) ?? {};
      for (const f of candidateFields) {
        const v = content[f];
        if (typeof v === 'string' && v.length > 0) return v;
      }
    }
    return 'missing';
  };

  const product_name = aggregateField(
    ['product_name', 'what'],
    ['purchase.assertion', 'defect.assertion', 'inquiry.product', 'inquiry.price'],
  );
  const product_condition = aggregateField(
    ['condition', 'detail'],
    ['defect.assertion'],
  );
  const order_id = aggregateField(
    ['order_id'],
    ['order.query', 'refund.request'],
  );
  const reason = aggregateField(
    ['reason', 'refund_reason'],
    ['refund.request', 'defect.assertion', 'escalation.request'],
  );

  const userOriginalComplaint = userInputRows[0]?.raw_input ?? current_user_input;

  return Object.freeze({
    user_original_complaint: userOriginalComplaint,
    product_name,
    product_condition,
    order_id,
    reason,
    verdict_trajectory: Object.freeze(verdictTrajectory),
    collected_verification: Object.freeze(collected),
  });
}

// 单例
// γ-3：mutable export pattern（与 governance.ts 同模式）。
// 模块加载时不再 new，由 src/index.ts 启动时 `new ConversationRuntime(service)`
// 后通过 setConversationRuntime 注入。
let _conversationRuntime: ConversationRuntime | undefined;

export function setConversationRuntime(r: ConversationRuntime): void {
  _conversationRuntime = r;
}

export function getConversationRuntime(): ConversationRuntime {
  if (!_conversationRuntime) {
    throw new Error('conversationRuntime not initialized — call setConversationRuntime() at startup');
  }
  return _conversationRuntime;
}
