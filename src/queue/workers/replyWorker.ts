import { writeLedger } from '../../db/ledger';
import { LLMAnalysis, generateReply, buildQuickReplies } from '../../services/llm';
import { buildSystemPrompt } from '../../services/promptBuilder';
import { extractAndBindFacts } from '../../services/factCheck';
import { judge as kernelJudge, REJECT_FALLBACK, GENERIC_FALLBACK } from '../../services/governanceKernel';
import { getKBSnapshot } from '../../services/kbCorpus';
import { getRecentHistory } from '../../services/conversationHistory';
import { executeAction, makeIdempotencyKey } from '../../kernel/executor';
import { pushProgress } from '../../ws/server';
import { consumeGroup, ackMsg, pushToQueue, QUEUES, GROUPS } from '../streams';
import { LedgerEvent } from '../../types/lios';
import { createEscalationSession } from '../../services/agentSession';
import { queryOne } from '../../db/client';
import { webSdkAdapter } from '../../channels/WebSDKChannelAdapter';

async function getTenantName(tenant_id: string): Promise<string> {
  const row = await queryOne<{ company_name: string }>(
    `SELECT company_name FROM lios_tenants WHERE tenant_id = $1`,
    [tenant_id],
  ).catch(() => null);
  return row?.company_name ?? '客服中心';
}

async function processReply(fields: Record<string, string>): Promise<void> {
  const {
    trace_id, tenant_id, session_id, user_message, intent_id,
    analysis_json, kb_context,
    decision_id,
    hallucination_guard,
  } = fields;

  pushProgress(trace_id, 'generating_reply', {});

  const analysis: LLMAnalysis  = JSON.parse(analysis_json);
  const hguard  = hallucination_guard === 'true';

  // ── 推理 + 治理 双层架构 ─────────────────────────────────────────
  const tenantName = await getTenantName(tenant_id);
  const kbSnap     = await getKBSnapshot(tenant_id);
  const history    = await getRecentHistory(session_id, tenant_id, 10);

  const MAX = 2;
  let attempt = 0;
  let kernelHint: string | undefined;
  let finalReply = '';
  let lastVerdict: 'accept' | 'hold' | 'reject' = 'reject';
  const attemptLog: Array<{ attempt: number; raw: string; verdict: string; unbound: string[]; tech: string[]; hint: string | null }> = [];

  while (attempt < MAX) {
    attempt++;
    const sys = buildSystemPrompt({
      tenantName, kbSummary: kbSnap.kbSummary, retrievedKB: kb_context, kernelHint,
    });
    const gen = await generateReply({
      systemPrompt: sys, history, userMessage: user_message,
      traceId: trace_id, tenantId: tenant_id,
    });
    const facts = await extractAndBindFacts(gen.reply, kbSnap, { traceId: trace_id, tenantId: tenant_id });
    const k = kernelJudge({ reply: gen.reply, factCheck: facts, attempt, maxAttempts: MAX });
    attemptLog.push({ attempt, raw: gen.reply, verdict: k.verdict, unbound: facts.unbound_claims, tech: facts.tech_word_violations, hint: k.missing_evidence_hint });

    if (k.verdict === 'accept') { finalReply = gen.reply; lastVerdict = 'accept'; break; }
    if (k.verdict === 'reject') { finalReply = REJECT_FALLBACK; lastVerdict = 'reject'; break; }
    kernelHint = k.missing_evidence_hint ?? undefined;
  }
  if (!finalReply) { finalReply = GENERIC_FALLBACK; lastVerdict = 'reject'; }

  const replyText    = finalReply;
  const quickReplies = buildQuickReplies(analysis.intent_type);
  const verdict      = lastVerdict;
  const replyMeta = {
    source:               'unified_llm_v2',
    attempts:             attempt,
    governance_verdict:   lastVerdict,
    attempt_log:          attemptLog,
  };

  // ── 副作用：根据 Kernel 裁决写 action / 转人工 ────────────────
  if (verdict === 'accept') {
    const ikey   = makeIdempotencyKey(decision_id, 'chat.reply');
    const result = await executeAction(
      decision_id,
      { action_type: 'chat.reply', payload: { reply: replyText, intent_type: analysis.intent_type, tenant_id }, idempotency_key: ikey },
      tenant_id,
    );
    const ev: LedgerEvent = result.is_new ? 'action.created' : 'action.idempotent_hit';
    await writeLedger('action', result.action.id, ev,
      { type: 'chat.reply', idempotency_key: ikey, hallucination_guard: hguard, ...replyMeta }, tenant_id,
    ).catch(() => {});
    if (result.is_new) {
      await writeLedger('action', result.action.id, 'action.executed',
        { result: 'ok', reply_length: replyText.length }, tenant_id,
      ).catch(() => {});
    }
  } else if (verdict === 'reject') {
    const ikey = makeIdempotencyKey(decision_id, 'chat.escalate');
    const result = await executeAction(
      decision_id,
      { action_type: 'chat.escalate', payload: { reason: analysis.intent_summary, tenant_id }, idempotency_key: ikey },
      tenant_id,
    );
    await writeLedger('action', result.action.id, 'action.created',
      { type: 'chat.escalate', ...replyMeta }, tenant_id,
    ).catch(() => {});
  }

  if (verdict === 'reject' || verdict === 'hold') {
    await createEscalationSession({
      tenant_id, session_id, intent_id,
      user_message,
      lios_reply:    replyText,
      reject_reason: verdict === 'reject'
        ? (analysis.intent_summary ?? 'reject')
        : `hold · ${analysis.intent_summary ?? '需要更多資訊'}`,
    }).catch(err => console.error('[Worker:reply] escalation failed:', err));
  }

  // Channel-aware reply push（Web SDK 实现：内部仍走 pushProgress on :3211）
  await webSdkAdapter.sendReply(trace_id, {
    text:          replyText,
    quick_replies: quickReplies,
    meta:          { verdict, session_id, trace_id, reply_meta: replyMeta },
  });

  await pushToQueue(QUEUES.LEDGER, {
    trace_id, tenant_id, session_id, intent_id, decision_id,
    reply:               replyText,
    guarded_verdict:     verdict,
    quick_replies_json:  JSON.stringify(quickReplies),
    intent_type:         analysis.intent_type,
    hallucination_guard: String(hguard),
  });
}

let _running = false;

export async function startReplyWorker(): Promise<void> {
  if (_running) return;
  _running = true;
  console.log('[Worker:reply] started');

  while (_running) {
    try {
      const msgs = await consumeGroup(QUEUES.REPLY, GROUPS.REPLY, 'reply-1');
      for (const { id, fields } of msgs) {
        try {
          await processReply(fields);
        } catch (err) {
          console.error('[Worker:reply] processing error:', err);
          if (fields.trace_id) pushProgress(fields.trace_id, 'error', { message: String(err) });
        } finally {
          await ackMsg(QUEUES.REPLY, GROUPS.REPLY, id);
        }
      }
    } catch (err) {
      if (!(err as Error).message?.includes('NOGROUP')) console.error('[Worker:reply] loop error:', err);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

export function stopReplyWorker(): void { _running = false; }
