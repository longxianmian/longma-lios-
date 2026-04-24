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
  generateGroundedReply,
  generateFallbackReply,
  buildQuickReplies,
} from '../services/llm';
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
      ? `企業知識庫（已按相關性排序）：\n${kbAssets.map(a => `【${a.name}】\n${a.content.slice(0, 500)}`).join('\n\n')}`
      : '';

    // ── Phase 2: LLM Call 1 — Intent analysis (no draft, no hallucination risk) ─
    let analysis: LLMAnalysis;
    try {
      analysis = await analyzeIntent(message, kbContext);
    } catch (err) {
      app.log.error({ err }, 'LLM analysis failed');
      return reply.code(200).send({
        reply: '抱歉，AI 服務暫時不可用，請聯繫人工客服（LINE：@lios-support）。',
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

    // ── Hallucination Guard ────────────────────────────────────────────────
    // If kernel accepted but KB is empty → cannot generate a grounded reply;
    // force downgrade to hold before any GPT response generation.
    let hallucination_guard = false;
    let guarded_verdict     = final_verdict;

    if (final_verdict === 'accept' && kbAssets.length === 0) {
      hallucination_guard = true;
      guarded_verdict     = 'hold';

      await writeLedger('intent', intent.id, 'kernel.scored', {
        hallucination_guard: true,
        reason:  'accept downgraded to hold: no KB assets available, cannot ground reply',
        kb_count: 0,
      }, tenant_id).catch(() => {});

      app.log.warn(
        { trace_id: intent.trace_id, tenant_id },
        '[HallucinationGuard] accept → hold: KB empty'
      );
    }

    // Update pack state using guarded verdict
    await query(
      `UPDATE lios_candidate_packs SET state=$1 WHERE id=$2`,
      [guarded_verdict === 'accept' ? '1' : '0', pack.id]
    ).catch(() => {});

    // ── Phase 8: Response Generation + Executor ────────────────────────────
    let replyText:    string;
    let quickReplies: string[];

    if (guarded_verdict === 'accept') {
      // KB content is present — generate a strictly grounded reply
      try {
        replyText = await generateGroundedReply(message, kbContext);
      } catch {
        replyText = '我目前沒有關於這個問題的資料，請聯繫人工客服（LINE：@lios-support）。';
      }
      quickReplies = buildQuickReplies(analysis.intent_type);

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
        { type: 'chat.reply', idempotency_key: ikey, hallucination_guard }, tenant_id
      ).catch(() => {});
      if (result.is_new) {
        await writeLedger('action', result.action.id, 'action.executed',
          { result: 'ok', reply_length: replyText.length, hallucination_guard }, tenant_id
        ).catch(() => {});
      }

    } else {
      // hold or reject → LLM Call for appropriate follow-up / escalation message
      try {
        replyText = await generateFallbackReply(message, guarded_verdict as 'hold' | 'reject', analysis);
      } catch {
        replyText = guarded_verdict === 'hold'
          ? '請提供更多資訊，以便我為您服務。'
          : '暫時無法回答此問題，建議聯繫人工客服（LINE：@lios-support）。';
      }
      quickReplies = guarded_verdict === 'hold'
        ? ['提供更多資訊', '聯繫人工客服', '換一個問題']
        : ['聯繫人工客服', '換一個問題'];

      if (guarded_verdict === 'reject') {
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
          { type: 'chat.escalate', idempotency_key: ikey, hallucination_guard }, tenant_id
        ).catch(() => {});
      }
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
