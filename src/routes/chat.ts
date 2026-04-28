import { FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import { query, queryOne } from '../db/client';
import { embedText, rankBySimilarity } from '../services/embedding';
import { runKernel } from '../kernel/liKernel';
import { runDecisionRuntime } from '../kernel/decisionRuntime';
import { executeAction, makeIdempotencyKey } from '../kernel/executor';
import {
  LLMAnalysis,
  analyzeIntent,
  generateReply,
  buildQuickReplies,
} from '../services/llm';
import { buildSystemPrompt, inferJourneyHint } from '../services/promptBuilder';
import { preJudge } from '../services/preKernel';
import { postAudit, summarizeAuditForHint, fallbackForVerdict } from '../services/postAudit';
import { getKBSnapshot } from '../services/kbCorpus';
import { getRecentHistory } from '../services/conversationHistory';
import { buildHandoffContext } from '../services/handoffContext';
import { createEscalationSession } from '../services/agentSession';
import { webSdkAdapter } from '../channels/WebSDKChannelAdapter';
import { mockOrderVerifier } from '../verifiers/MockOrderVerifier';
import { summarizeVerification, VerifyResult } from '../verifiers/types';
import { getEscalationStatus, markEscalated } from '../services/conversationState';
import { getOrderNotFoundAttempts } from '../services/orderProbeStats';
import { getConversationRuntime } from '../runtime/ConversationRuntime';

/** 当前 LIOS 实例可用 verifier 列表 — Phase 1 demo 阶段只有 mock */
const AVAILABLE_VERIFIERS = ['mock'];
import { QUEUES, pushToQueue } from '../queue/streams';
import {
  LiosIntent,
  LiosCandidatePack,
  LiosEvidenceItem,
  LedgerEvent,
} from '../types/lios';

const DEFAULT_QUICK_REPLIES = ['查詢訂單狀態', '退換貨申請', '商品詳情諮詢', '人工客服'];

// ── Ledger helper ─────────────────────────────────────────────────────────────
async function writeLedger(
  entityType: string,
  entityId:   string,
  eventType:  LedgerEvent,
  payload:    Record<string, unknown>,
  tenantId:   string
): Promise<void> {
  await query(
    `INSERT INTO lios_ledgers (entity_type, entity_id, event_type, payload, tenant_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [entityType, entityId, eventType, JSON.stringify(payload), tenantId]
  );
}

// ── Agent configs ─────────────────────────────────────────────────────────────
const AGENT_CONFIGS: Record<string, {
  name: string; avatar: string; welcome_message: string;
  quick_replies: string[]; brand_color: string; human_contact: string;
}> = {
  default: {
    name: '智能客服', avatar: '',
    welcome_message: '您好！我是智能客服助手，有什么可以帮您的吗？',
    quick_replies: DEFAULT_QUICK_REPLIES,
    brand_color: '#4F46E5', human_contact: 'LINE ID: @lios-support',
  },
  demo: {
    name: '小美客服', avatar: '',
    welcome_message: '您好！我是小美，龍碼智能客服助手 🌟\n\n有什麼可以幫到您的嗎？',
    quick_replies: ['查詢訂單', '退換貨申請', '商品諮詢', '人工客服'],
    brand_color: '#4F46E5', human_contact: 'LINE ID: @longma-support',
  },
};

function getAgentConfig(tenantId: string, employeeId?: string) {
  const key = employeeId ?? tenantId;
  return AGENT_CONFIGS[key] ?? AGENT_CONFIGS[tenantId] ?? AGENT_CONFIGS.default;
}

// ── Route handlers ────────────────────────────────────────────────────────────
export async function chatRoutes(app: FastifyInstance) {

  // ── GET /lios/chat/config ─────────────────────────────────────────────────
  app.get<{
    Querystring: { tenant_id: string; employee_id?: string };
  }>('/lios/chat/config', {
    schema: {
      querystring: {
        type: 'object', required: ['tenant_id'],
        properties: {
          tenant_id:   { type: 'string', minLength: 1 },
          employee_id: { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    const { tenant_id, employee_id } = req.query;
    const tenant = await queryOne<{ company_name: string }>(
      'SELECT company_name FROM lios_tenants WHERE tenant_id=$1', [tenant_id]
    ).catch(() => null);
    const config = getAgentConfig(tenant_id, employee_id);
    return reply.code(200).send({
      tenant_id,
      employee_id: employee_id ?? 'default',
      name: tenant ? `${tenant.company_name} 客服` : config.name,
      avatar: config.avatar,
      welcome_message: config.welcome_message,
      quick_replies: config.quick_replies,
      brand_color: config.brand_color,
      human_contact: config.human_contact,
    });
  });

  // ── POST /lios/chat ── Full LIOS Protocol Pipeline ────────────────────────
  app.post<{
    Body: {
      tenant_id:    string;
      employee_id?: string;
      user_id?:     string;
      session_id?:  string;
      message:      string;
      lang?:        string;
    };
  }>('/lios/chat', {
    schema: {
      body: {
        type: 'object', required: ['tenant_id', 'message'],
        properties: {
          tenant_id:   { type: 'string', minLength: 1 },
          employee_id: { type: 'string' },
          user_id:     { type: 'string' },
          session_id:  { type: 'string' },
          message:     { type: 'string', minLength: 1, maxLength: 500 },
          lang:        { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    const {
      tenant_id,
      session_id = randomUUID(),
      message,
    } = req.body;

    // ── v2.1 灰度切换（T11 阶段 2：v2_1 已是默认；旧链路保留作为 kill-switch）──
    // 优先级：HTTP header X-LIOS-Runtime > env LIOS_RUNTIME > 默认值 v2_1
    // 取值 'legacy' → 强制走旧链路（preKernel + promptBuilder + postAudit）—— 紧急回滚通道
    // 取值 'v2_1' 或缺省 → 走新治理管线
    // T11 阶段 3（约 1 周后）：删除整个旧链路 + 移除 flag
    const headerFlag = String((req.headers['x-lios-runtime'] ?? '') as string).toLowerCase();
    const envFlag = (process.env.LIOS_RUNTIME ?? '').toLowerCase();
    const explicitLegacy = headerFlag === 'legacy' || envFlag === 'legacy';
    const useV21 = !explicitLegacy;
    if (useV21) {
      const guard0 = await getEscalationStatus(session_id);
      if (guard0?.status === 'escalated') {
        const guardedReply = '您的請求已在人工客服處理中，請稍候，客服會盡快回覆您。';
        return reply.code(200).send({
          reply: guardedReply,
          reply_type: 'text',
          quick_replies: ['等待人工'],
          session_id,
          pipeline: { guard: 'escalation_in_progress', runtime: 'v2_1' },
        });
      }
      try {
        const r = await getConversationRuntime().handle({
          tenant_id, session_id, message, lang: req.body.lang,
          user_id: req.body.user_id, channel: 'web_sdk',
        });
        // 触发 markEscalated（让旧的 escalation 守卫继续生效）
        if (r.verdict_legacy === -2) {
          await markEscalated({
            session_id, tenant_id,
            reason: r.handoff_context?.user_original_complaint ?? 'v2_1_escalation',
            handoff_payload: r.handoff_context as Record<string, unknown> | undefined,
          }).catch(() => {});
        }
        return reply.code(200).send({
          reply: r.reply,
          reply_type: 'text',
          quick_replies: [...r.quick_replies],
          session_id,
          trace_id: r.trace_id,
          pipeline: r.pipeline,
        });
      } catch (err) {
        app.log.error({ err }, '[runtime v2_1] failed; falling back to legacy path');
        // 不直接 500：继续走旧链路（保持 200 体验）
      }
    }

    // ── Phase 0: 入口守卫（在 preKernel 之前）─────────────────────────
    // 已转人工的会话：跳过 LLM 全部流程，固定话术回复
    // 仅在 agent 端显式标记完成后才解除
    const escalationGuard = await getEscalationStatus(session_id);
    if (escalationGuard?.status === 'escalated') {
      const guardedReply = '您的請求已在人工客服處理中，請稍候，客服會盡快回覆您。';
      await webSdkAdapter.sendReply(session_id, {
        text: guardedReply,
        meta: { guard: 'escalation_in_progress', escalated_at: escalationGuard.escalated_at },
      }).catch(() => {});
      return reply.code(200).send({
        reply:         guardedReply,
        reply_type:    'text',
        quick_replies: ['等待人工'],
        session_id,
        pipeline: {
          guard:               'escalation_in_progress',
          conversation_status: 'escalated',
          escalated_at:        escalationGuard.escalated_at,
          escalation_reason:   escalationGuard.escalation_reason,
        },
      });
    }

    // ── Phase 1: Candidate Space — vector search (fallback: full load) ───────
    const kbAssets = await (async () => {
      // Try vector similarity search first
      const withVec = await query<{
        id: string; name: string; content: string; asset_type: string; embedding: number[];
      }>(
        `SELECT id, name, content, asset_type, embedding FROM lios_assets
         WHERE tenant_id=$1 AND is_indexed=TRUE AND embedding IS NOT NULL
           AND content NOT LIKE '[待转录：%'`,
        [tenant_id]
      ).catch(() => []);

      if (withVec.length > 0) {
        try {
          const queryVec = await embedText(message);
          return rankBySimilarity(queryVec, withVec, 5)
            .filter(a => a.similarity > 0.3);   // drop irrelevant assets
        } catch {
          // embedding query failed — fall through to text load
        }
      }

      // Fallback: load all indexed assets without placeholder content
      return query<{ id: string; name: string; content: string; asset_type: string }>(
        `SELECT id, name, content, asset_type FROM lios_assets
         WHERE tenant_id=$1 AND is_indexed=TRUE
           AND content NOT LIKE '[待转录：%'
         ORDER BY created_at DESC LIMIT 8`,
        [tenant_id]
      ).catch(() => []);
    })();

    const kbContext = kbAssets.length > 0
      ? `企業內部資料（已按相關性排序）：\n${kbAssets.map(a => `【${a.name}】\n${a.content.slice(0, 500)}`).join('\n\n')}`
      : '';

    // ── Phase 2a: Load conversation history ───────────────────────────────
    const history = await getRecentHistory(session_id, tenant_id, 10);

    // ── Phase 2b: Intent analysis（保留：旧 Kernel 链路仍需要） ───────────
    let analysis: LLMAnalysis;
    try {
      analysis = await analyzeIntent(message, kbContext, { tenant_id });
    } catch (err) {
      app.log.error({ err }, 'LLM analysis failed');
      return reply.code(200).send({
        reply: '抱歉，服務暫時不可用，請聯繫人工客服（LINE：@lios-support）。',
        reply_type: 'text',
        quick_replies: ['聯繫人工客服'],
        session_id,
        pipeline: { error: 'llm_unavailable' },
      });
    }

    // ── Phase 3: Create Intent record ─────────────────────────────────────
    const [intent] = await query<LiosIntent>(
      `INSERT INTO lios_intents
         (tenant_id, session_id, raw_input, parsed_goal, status)
       VALUES ($1, $2, $3, $4, 'processing')
       RETURNING *`,
      [
        tenant_id, session_id, message,
        JSON.stringify({
          intent_type:    analysis.intent_type,
          intent_summary: analysis.intent_summary,
          confidence:     analysis.confidence,
          out_of_scope:   analysis.out_of_scope,
        }),
      ]
    );

    await writeLedger('intent', intent.id, 'intent.created',
      { session_id, trace_id: intent.trace_id, tenant_id }, tenant_id
    ).catch(() => {});

    // ── Phase 4: LLM reply → CandidatePack (source_type='llm') ────────────
    // out_of_scope or very low confidence → score drops to force kernel reject
    const candidateScore = analysis.out_of_scope
      ? 0.10
      : Math.max(0, Math.min(1, analysis.confidence));

    const [pack] = await query<LiosCandidatePack>(
      `INSERT INTO lios_candidate_packs
         (intent_id, tenant_id, name, description, score, state, source_type, metadata)
       VALUES ($1, $2, $3, $4, $5, '-1', 'llm', $6)
       RETURNING *`,
      [
        intent.id, tenant_id,
        `llm-reply-${intent.id.slice(0, 8)}`,
        analysis.intent_summary.slice(0, 300),
        candidateScore,
        JSON.stringify({
          model:          'gpt-4o-mini',
          intent_type:    analysis.intent_type,
          intent_summary: analysis.intent_summary,
        }),
      ]
    );

    await writeLedger('pack', pack.id, 'pack.created',
      { source_type: 'llm', score: candidateScore, intent_type: analysis.intent_type }, tenant_id
    ).catch(() => {});

    // ── Phase 5: KB assets → Evidence (trust_level='L3') ──────────────────
    //             out_of_scope → synthetic L4 evidence (forces kernel reject)
    const evidenceRows: LiosEvidenceItem[] = [];

    if (analysis.out_of_scope || analysis.confidence < 0.5) {
      // Inject L4-only evidence to trigger pure-L4 reject path in kernel
      for (const [label, content] of [
        ['out_of_scope_signal', `意圖分類：${analysis.intent_type}，置信度：${analysis.confidence}，超出業務範圍`],
        ['no_kb_match',         `知識庫未找到相關內容，無法支持此回覆`],
      ]) {
        const [ev] = await query<LiosEvidenceItem>(
          `INSERT INTO lios_evidence_items
             (tenant_id, type, source, content, trust_level, weight)
           VALUES ($1, 'signal', $2, $3, 'L4', 0.40)
           RETURNING *`,
          [tenant_id, label, content]
        );
        evidenceRows.push(ev);
        await query(
          `INSERT INTO lios_evidence_pack_index (pack_id, evidence_id, relevance_score)
           VALUES ($1, $2, 0.40) ON CONFLICT (pack_id, evidence_id) DO NOTHING`,
          [pack.id, ev.id]
        );
      }
    } else {
      // Session context as L2 base evidence (always valid when not out_of_scope)
      const [sessionEv] = await query<LiosEvidenceItem>(
        `INSERT INTO lios_evidence_items
           (tenant_id, type, source, content, trust_level, weight)
         VALUES ($1, 'fact', 'session_context', $2, 'L2', 0.85)
         RETURNING *`,
        [tenant_id, `session=${session_id} intent=${analysis.intent_type} valid`]
      );
      evidenceRows.push(sessionEv);
      await query(
        `INSERT INTO lios_evidence_pack_index (pack_id, evidence_id, relevance_score)
         VALUES ($1, $2, 0.85) ON CONFLICT (pack_id, evidence_id) DO NOTHING`,
        [pack.id, sessionEv.id]
      );

      // KB assets → L3 evidence
      for (const asset of kbAssets) {
        const [ev] = await query<LiosEvidenceItem>(
          `INSERT INTO lios_evidence_items
             (tenant_id, type, source, content, trust_level, weight)
           VALUES ($1, 'fact', $2, $3, 'L3', 0.80)
           RETURNING *`,
          [
            tenant_id,
            `kb:${asset.asset_type}:${asset.id}`,
            asset.content.slice(0, 300),
          ]
        );
        evidenceRows.push(ev);
        await query(
          `INSERT INTO lios_evidence_pack_index (pack_id, evidence_id, relevance_score)
           VALUES ($1, $2, 0.80) ON CONFLICT (pack_id, evidence_id) DO NOTHING`,
          [pack.id, ev.id]
        );
        await writeLedger('evidence', ev.id, 'evidence.added',
          { trust_level: 'L3', asset_id: asset.id, source: `kb:${asset.asset_type}` }, tenant_id
        ).catch(() => {});
      }
    }

    // ── Phase 6: LI Kernel — 三態裁決 ─────────────────────────────────────
    const kernelResult = runKernel(
      [{ id: pack.id, name: pack.name, score: Number(pack.score) }],
      evidenceRows.map(e => ({ id: e.id, trust_level: e.trust_level, weight: Number(e.weight) }))
    );

    await writeLedger('intent', intent.id, 'kernel.scored', {
      verdict:      kernelResult.verdict,
      kernel_score: kernelResult.kernel_score,
      reason:       kernelResult.reason,
      evidence_summary: kernelResult.evidence_summary,
    }, tenant_id).catch(() => {});

    app.log.info({
      trace_id:    intent.trace_id,
      verdict:     kernelResult.verdict,
      kernel_score: kernelResult.kernel_score,
      intent_type: analysis.intent_type,
      confidence:  analysis.confidence,
    }, 'LI Kernel verdict');

    // ── Phase 7: Decision Runtime (三態 + hold 超限自動 reject) ────────────
    const { decision, final_verdict, hold_escalated, session_hold_count } =
      await runDecisionRuntime({
        intentId:   intent.id,
        sessionId:  session_id,
        tenantId:   tenant_id,
        packId:     pack.id,
        kernel:     kernelResult,
        confidence: candidateScore,
      });

    const decisionEvent: LedgerEvent = hold_escalated ? 'decision.hold_escalated' : 'decision.made';
    await writeLedger('decision', decision.id, decisionEvent, {
      type:               final_verdict,
      hold_count:         decision.hold_count,
      hold_escalated,
      session_hold_count,
      kernel_score:       kernelResult.kernel_score,
      tenant_id,
    }, tenant_id).catch(() => {});

    // ── Phase 7.5: Hallucination Guard ───────────────────────────────────
    let hallucination_guard = false;
    let guarded_verdict     = final_verdict;
    if (final_verdict === 'accept' && kbAssets.length === 0) {
      hallucination_guard = true;
      guarded_verdict     = 'hold';
    }
    await query(
      `UPDATE lios_candidate_packs SET state=$1 WHERE id=$2`,
      [guarded_verdict === 'accept' ? '1' : '0', pack.id]
    ).catch(() => {});

    // ── Phase 8: 推理 + 治理（双层架构）────────────────────────────────
    //   LLM 层：不知道自己处于哪个 verdict，凭角色 + 边界 + history 自由推理
    //   Kernel 层：抽取事实声明 + 绑 KB → accept / hold-retry / reject
    const tenantRow = await queryOne<{ company_name: string }>(
      `SELECT company_name FROM lios_tenants WHERE tenant_id = $1`,
      [tenant_id],
    ).catch(() => null);
    const tenantName = tenantRow?.company_name ?? '客服中心';

    const kbSnap = await getKBSnapshot(tenant_id);

    // ── T2.1：聚合本会话历史的 order_not_found_attempts ────────────
    const notFoundAttempts = await getOrderNotFoundAttempts(session_id, tenant_id);

    // ── 事前裁决（第一次）：preKernel 划定初步权限 + 抽取 identifiers ──
    let preDecision = await preJudge({
      userMessage: message,
      history,
      kb: kbSnap,
      meta: { traceId: intent.trace_id, tenantId: tenant_id },
      not_found_attempts:  notFoundAttempts,
      available_verifiers: AVAILABLE_VERIFIERS as unknown as Parameters<typeof preJudge>[0]['available_verifiers'],
      capabilities:        webSdkAdapter.supported_capabilities as unknown as Record<string, boolean>,
    });
    const firstPassVerdict = preDecision.verdict;
    const firstPassScope   = preDecision.scope;

    // ── 订单核验（如果抽到 order_id）+ 二次 preKernel ─────────────────
    const verificationsPerformed: Array<{
      type:         string;
      verifier:     string;
      input:        string;
      result:       string;
      order_status?: string;
      latency_ms:   number;
    }> = [];

    // ── 守卫：如果本会话已在 escalation_intake 流程，verifier 让位给 escalate ──
    const lastBotTurn = [...history].reverse().find(t => t.role === 'bot');
    const inEscalationFlow = !!lastBotTurn && /轉接人工|轉接客服|為您轉接|將為您|資料已轉給人工/.test(lastBotTurn.content);
    if (inEscalationFlow && preDecision.verdict !== -2) {
      // 用户在 intake 流程中提供了任何信息（订单号 / 问题描述）→ 升级到 escalate complete
      preDecision = {
        ...preDecision,
        verdict:     -2,
        scope:       ['escalation_complete'],
        instruction: '告知用戶資料已轉給人工客服，30 字內。',
        reason:      'in escalation_intake flow, user provided info → escalate complete',
      };
    }

    let verifiedOrderBlock = '';
    const orderIdIdent = preDecision.extracted_identifiers.find(i => i.type === 'order_id');

    // T3.4：用户明示了订单来源渠道；当前 demo 阶段只配 mock，其他渠道跳过 verifier
    const userClaimedSource   = preDecision.extracted_order_source;
    const sourceMismatched    = !!userClaimedSource && userClaimedSource !== 'mock' && !AVAILABLE_VERIFIERS.includes(userClaimedSource);
    // 同一 order_id 已 not_found ≥ 3 次，本轮不再调 verifier（preKernel 应该已升级 escalation_intake）
    const tooManyAttempts     = !!orderIdIdent && (notFoundAttempts[orderIdIdent.value] ?? 0) >= 3;

    if (orderIdIdent && !inEscalationFlow && preDecision.verdict !== -2 && !sourceMismatched && !tooManyAttempts) {
      const verify: VerifyResult = await mockOrderVerifier.verifyByOrderId(orderIdIdent.value, {
        tenant_id, shop_id: 'demo', channel: 'web_sdk',
      });
      verificationsPerformed.push({
        type:         'order',
        verifier:     mockOrderVerifier.source,
        input:        orderIdIdent.value,
        result:       verify.classification,
        order_status: verify.order?.status,
        latency_ms:   verify.latency_ms ?? 0,
      });

      // 把核验结果作为补充上下文，再走一次 preKernel（同样带 not_found_attempts 等上下文）
      const verifyCtx = summarizeVerification(verify);
      preDecision = await preJudge({
        userMessage: message,
        history,
        kb: kbSnap,
        meta: { traceId: intent.trace_id, tenantId: tenant_id },
        verification_context: verifyCtx,
        not_found_attempts:  { ...notFoundAttempts, [orderIdIdent.value]: (notFoundAttempts[orderIdIdent.value] ?? 0) + (verify.classification === 'not_found' ? 1 : 0) },
        available_verifiers: AVAILABLE_VERIFIERS as unknown as Parameters<typeof preJudge>[0]['available_verifiers'],
        capabilities:        webSdkAdapter.supported_capabilities as unknown as Record<string, boolean>,
      });

      // 把订单详情作为"事实通道"附加进 retrievedKB，让 LLM-gen 直接看到（可以复述）
      if (verify.order && verify.belongs_to_shop) {
        const o = verify.order;
        const itemsLine = o.items.map(it => `${it.qty}x ${it.name}（單價 ${it.price} ${o.currency}）`).join('；');
        verifiedOrderBlock = `\n\n【系統核驗·已確認訂單】\n訂單編號：${o.order_id}\n商品：${itemsLine}\n總額：${o.total_amount} ${o.currency}\n狀態：${o.status}\n下單時間：${o.purchased_at}\n${o.return_eligible_until ? '退貨期限：' + o.return_eligible_until : ''}\n（這些事實由系統核驗得出，可以直接引用。）`;
      }

      // ── 硬护栏：当 verifier=not_found 且当前 order_id attempts < 3 时，
      //    禁止 LLM 自加 escalation_intake / order_lookup_failed，避免误升级
      const currentAttempts = (notFoundAttempts[orderIdIdent.value] ?? 0) + 1;  // 含本轮
      if (verify.classification === 'not_found' && currentAttempts < 3) {
        const cleanedScope = preDecision.scope.filter(s => s !== 'escalation_intake' && s !== 'order_lookup_failed');
        if (!cleanedScope.includes('order_not_found')) cleanedScope.push('order_not_found');
        if (cleanedScope.length !== preDecision.scope.length) {
          preDecision = {
            ...preDecision,
            scope:       cleanedScope,
            instruction: currentAttempts === 1
              ? '請您確認訂單編號是否完整正確，例如有沒有少一位或多一位。一句話即可。'
              : '請提供下單時的手機號末四位或購買日期，並告訴我下單渠道（官網/Shopee/Lazada/momo 等）。',
            reason:      preDecision.reason + ' ; guard: not_found N<3, removed premature escalation',
          };
        }
      }
    }

    // ── LLM 在权限内生成 + 事后审计；越权则带 hint 重生成（最多 2 次） ──
    const MAX_ATTEMPTS = 2;
    let attempt = 0;
    let kernelHint: string | undefined;
    let finalReply = '';
    let lastVerdict: 'accept' | 'hold' | 'reject' | 'escalate' =
      preDecision.verdict === 1  ? 'accept'   :
      preDecision.verdict === -1 ? 'reject'   :
      preDecision.verdict === -2 ? 'escalate' :
      'hold';

    const journeyHint = inferJourneyHint(history);
    const attemptLog: Array<{ attempt: number; raw: string; passed: boolean; violations: unknown[]; hint: string | null }> = [];

    while (attempt < MAX_ATTEMPTS) {
      attempt++;
      const sysPrompt = buildSystemPrompt({
        tenantName,
        kbSummary:   kbSnap.kbSummary,
        retrievedKB: kbContext + verifiedOrderBlock,
        kernelHint,
        journeyHint,
        preKernel:   preDecision,
      });
      const gen = await generateReply({
        systemPrompt: sysPrompt,
        history,
        userMessage: message,
        traceId:     intent.trace_id,
        tenantId:    tenant_id,
      });
      const audit = await postAudit({
        reply:     gen.reply,
        preKernel: preDecision,
        kb:        kbSnap,
        meta:      { traceId: intent.trace_id, tenantId: tenant_id },
      });
      attemptLog.push({
        attempt,
        raw:        gen.reply,
        passed:     audit.passed,
        violations: audit.violations,
        hint:       audit.passed ? null : summarizeAuditForHint(audit, preDecision),
      });

      if (audit.passed) {
        finalReply = gen.reply;
        break;
      }
      kernelHint = summarizeAuditForHint(audit, preDecision);
    }
    if (!finalReply) {
      finalReply = fallbackForVerdict(preDecision);
    }

    const replyText    = finalReply;
    const quickReplies = buildQuickReplies(analysis.intent_type);

    // 计算 claims_verification_status：scope[0] 对应的 claim 标 "asking_now"，
    // 其它 user_claims 标 "blocked_by_prior_claim"（按 scope 顺序逐项核验）
    const claimsVerificationStatus: Record<string, string> = {};
    if (preDecision.user_claims.length > 0) {
      if (preDecision.verdict === 0 && preDecision.scope.length > 0) {
        // hold 状态：第一个 claim 正在追问，其它阻塞
        preDecision.user_claims.forEach((c, i) => {
          claimsVerificationStatus[c] = i === 0 ? 'asking_now' : 'blocked_by_prior_claim';
        });
      } else if (preDecision.verdict === 1) {
        // accept：claim 已被 KB 满足或不需核验
        preDecision.user_claims.forEach(c => {
          claimsVerificationStatus[c] = 'covered_by_kb';
        });
      } else {
        // reject：claims 没有继续核验的意义
        preDecision.user_claims.forEach(c => {
          claimsVerificationStatus[c] = 'out_of_scope';
        });
      }
    }

    const replyMeta = {
      source:                       'unified_llm_v3_pre_kernel',
      attempts:                     attempt,
      pre_verdict:                  preDecision.verdict,
      pre_reason:                   preDecision.reason,
      pre_scope:                    preDecision.scope,
      pre_instruction:              preDecision.instruction,
      governance_verdict:           lastVerdict,
      attempt_log:                  attemptLog,
      user_claims_extracted:        preDecision.user_claims,
      claims_verification_status:   claimsVerificationStatus,
      repeat_count:                 preDecision.repeat_count,
      // ── v8 字段 ────────────────────────────────────────
      channel:                      'web_sdk',
      extracted_identifiers:        preDecision.extracted_identifiers,
      verifications_performed:      verificationsPerformed,
      first_pass_verdict:           firstPassVerdict,
      first_pass_scope:             firstPassScope,
      second_pass_verdict:          verificationsPerformed.length > 0 ? preDecision.verdict : null,
      second_pass_scope:            verificationsPerformed.length > 0 ? preDecision.scope   : null,
      // ── v9 字段（本轮新增）─────────────────────────────
      extracted_order_source:       preDecision.extracted_order_source,
      is_pure_affirmation:          preDecision.is_pure_affirmation,
      not_found_attempts:           notFoundAttempts,
      available_verifiers:          AVAILABLE_VERIFIERS,
      supported_capabilities:       webSdkAdapter.supported_capabilities,
    };

    // 行为副作用基于「治理裁决」(lastVerdict)
    if (lastVerdict === 'accept') {
      const ikey   = makeIdempotencyKey(decision.id, 'chat.reply');
      const result = await executeAction(
        decision.id,
        {
          action_type:     'chat.reply',
          payload:         { reply: replyText, intent_type: analysis.intent_type, tenant_id },
          idempotency_key: ikey,
        },
        tenant_id
      );
      const actionEvent: LedgerEvent = result.is_new ? 'action.created' : 'action.idempotent_hit';
      await writeLedger('action', result.action.id, actionEvent,
        { type: 'chat.reply', idempotency_key: ikey, hallucination_guard, ...replyMeta }, tenant_id
      ).catch(() => {});
      if (result.is_new) {
        await writeLedger('action', result.action.id, 'action.executed',
          { result: 'ok', reply_length: replyText.length, hallucination_guard }, tenant_id
        ).catch(() => {});
      }
    } else if (lastVerdict === 'escalate') {
      // verdict=-2：触发真正的转人工动作 + 上下文打包
      const handoffCtx = await buildHandoffContext(session_id, tenant_id).catch(err => {
        app.log.error({ err }, 'buildHandoffContext failed');
        return null;
      });

      const ikey = makeIdempotencyKey(decision.id, 'chat.escalate');
      const result = await executeAction(
        decision.id,
        {
          action_type:     'chat.escalate',
          payload:         { reason: 'user_requested_human', tenant_id, handoff_context: handoffCtx ?? undefined, channel: 'web_sdk' },
          idempotency_key: ikey,
        },
        tenant_id
      );
      await writeLedger('action', result.action.id, 'action.created',
        { type: 'chat.escalate', idempotency_key: ikey, hallucination_guard, ...replyMeta, handoff_context_built: !!handoffCtx }, tenant_id
      ).catch(() => {});

      // 创建 agent 会话，把 handoff_context 写进 lios_agent_sessions.handoff_context
      await createEscalationSession({
        tenant_id,
        session_id,
        intent_id:     intent.id,
        user_message:  message,
        lios_reply:    replyText,
        reject_reason: 'user_requested_human · handoff_packaged',
        handoff_context: (handoffCtx as unknown as Record<string, unknown>) ?? undefined,
      }).catch(err => app.log.error({ err }, 'createEscalationSession (escalate) failed'));

      // 通知 channel adapter（Web SDK 实现：在 user-facing WS 推一条 escalation 通知）
      await webSdkAdapter.escalateToHuman(session_id, {
        conversation_id:         session_id,
        user_original_complaint: handoffCtx?.user_original_complaint ?? message,
        collected_verification:  handoffCtx?.collected_verification ?? {},
        verdict_trajectory:      handoffCtx?.verdict_trajectory ?? [],
        blocked_claims:          handoffCtx?.blocked_claims ?? [],
        raw_handoff_context:     (handoffCtx as unknown as Record<string, unknown>) ?? undefined,
      }).catch(err => app.log.error({ err }, 'webSdkAdapter.escalateToHuman failed'));

      // T1.3：写入 conversation_states.status='escalated'，下一轮入口守卫拦截
      await markEscalated({
        session_id,
        tenant_id,
        reason:          preDecision.reason || 'verdict=-2',
        handoff_payload: (handoffCtx as unknown as Record<string, unknown>) ?? null,
      });
    } else {
      // hold (fallback) 或 reject 都按 escalate 写 ledger（无完整上下文打包）
      const ikey = makeIdempotencyKey(decision.id, 'chat.escalate');
      const result = await executeAction(
        decision.id,
        {
          action_type:     'chat.escalate',
          payload:         { reason: kernelResult.reason, intent_type: analysis.intent_type, tenant_id },
          idempotency_key: ikey,
        },
        tenant_id
      );
      await writeLedger('action', result.action.id, 'action.created',
        { type: 'chat.escalate', idempotency_key: ikey, hallucination_guard, ...replyMeta }, tenant_id
      ).catch(() => {});
    }

    // ── Phase 9: Close Intent ─────────────────────────────────────────────
    const intentStatusMap = { accept: 'accepted', hold: 'held', reject: 'rejected' } as const;
    const finalStatus = intentStatusMap[guarded_verdict] ?? 'completed';

    await query(
      `UPDATE lios_intents SET status=$1, updated_at=NOW() WHERE id=$2`,
      [finalStatus, intent.id]
    ).catch(() => {});

    await writeLedger('intent', intent.id, 'ledger.closed', {
      final_state:         finalStatus,
      trace_id:            intent.trace_id,
      hallucination_guard,
      tenant_id,
    }, tenant_id).catch(() => {});

    // ── Response ──────────────────────────────────────────────────────────
    return reply.code(200).send({
      reply:        replyText,
      reply_type:   'text',
      quick_replies: quickReplies,
      session_id,
      trace_id:     intent.trace_id,
      pipeline: {
        intent_id:          intent.id,
        intent_type:        analysis.intent_type,
        intent_summary:     analysis.intent_summary,
        decision:           guarded_verdict,
        kernel_verdict:     final_verdict,
        kernel_score:       kernelResult.kernel_score,
        confidence:         analysis.confidence,
        candidate_score:    candidateScore,
        kb_assets_used:     kbAssets.length,
        evidence_count:     evidenceRows.length,
        hold_escalated,
        session_hold_count,
        kernel_reason:      kernelResult.reason,
        hallucination_guard,
      },
    });
  });

  // ── POST /lios/chat/async ── P1: 立即返回 trace_id，队列异步处理 ─────────
  app.post<{
    Body: {
      tenant_id:    string;
      employee_id?: string;
      user_id?:     string;
      session_id?:  string;
      message:      string;
      lang?:        string;
    };
  }>('/lios/chat/async', {
    schema: {
      body: {
        type: 'object', required: ['tenant_id', 'message'],
        properties: {
          tenant_id:   { type: 'string', minLength: 1 },
          employee_id: { type: 'string' },
          user_id:     { type: 'string' },
          session_id:  { type: 'string' },
          message:     { type: 'string', minLength: 1, maxLength: 500 },
          lang:        { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    const { tenant_id, session_id = randomUUID(), message } = req.body;

    // Create intent record immediately (trace_id is DB-generated UUID)
    const [intent] = await query<LiosIntent>(
      `INSERT INTO lios_intents
         (tenant_id, session_id, raw_input, parsed_goal, status)
       VALUES ($1, $2, $3, $4, 'pending')
       RETURNING *`,
      [tenant_id, session_id, message, JSON.stringify({ async: true })],
    );

    // Push to intent_queue — workers will process and push via WebSocket
    try {
      await pushToQueue(QUEUES.INTENT, {
        trace_id:    intent.trace_id,
        tenant_id,
        session_id,
        user_message: message,
        intent_id:   intent.id,
        timestamp:   new Date().toISOString(),
      });
    } catch (err) {
      app.log.error({ err }, '[async] Redis push failed — falling back');
      return reply.code(503).send({ error: 'queue_unavailable', message: 'Redis not available' });
    }

    return reply.code(202).send({
      trace_id:  intent.trace_id,
      session_id,
      ws_url:    'ws://localhost:3211',
      status:    'queued',
    });
  });
}
