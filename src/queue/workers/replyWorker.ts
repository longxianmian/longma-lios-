import { writeLedger } from '../../db/ledger';
import {
  LLMAnalysis, generateGroundedReply, generateFallbackReply, buildQuickReplies,
} from '../../services/llm';
import { executeAction, makeIdempotencyKey } from '../../kernel/executor';
import { pushProgress } from '../../ws/server';
import { consumeGroup, ackMsg, pushToQueue, QUEUES, GROUPS } from '../streams';
import { DecisionType, LedgerEvent } from '../../types/lios';

async function processReply(fields: Record<string, string>): Promise<void> {
  const {
    trace_id, tenant_id, session_id, user_message, intent_id,
    analysis_json, kb_context,
    decision_id,
    guarded_verdict,
    hallucination_guard,
  } = fields;

  pushProgress(trace_id, 'generating_reply', {});

  const analysis: LLMAnalysis  = JSON.parse(analysis_json);
  const verdict = guarded_verdict as DecisionType;
  const hguard  = hallucination_guard === 'true';

  let replyText:    string;
  let quickReplies: string[];

  if (verdict === 'accept') {
    try {
      replyText = await generateGroundedReply(user_message, kb_context);
    } catch {
      replyText = '我目前沒有關於這個問題的資料，請聯繫人工客服（LINE：@lios-support）。';
    }
    quickReplies = buildQuickReplies(analysis.intent_type);

    const ikey   = makeIdempotencyKey(decision_id, 'chat.reply');
    const result = await executeAction(
      decision_id,
      { action_type: 'chat.reply', payload: { reply: replyText, intent_type: analysis.intent_type, tenant_id }, idempotency_key: ikey },
      tenant_id,
    );
    const ev: LedgerEvent = result.is_new ? 'action.created' : 'action.idempotent_hit';
    await writeLedger('action', result.action.id, ev,
      { type: 'chat.reply', idempotency_key: ikey, hallucination_guard: hguard }, tenant_id,
    ).catch(() => {});
    if (result.is_new) {
      await writeLedger('action', result.action.id, 'action.executed',
        { result: 'ok', reply_length: replyText.length }, tenant_id,
      ).catch(() => {});
    }
  } else {
    try {
      replyText = await generateFallbackReply(user_message, verdict as 'hold' | 'reject', analysis);
    } catch {
      replyText = verdict === 'hold'
        ? '請提供更多資訊，以便我為您服務。'
        : '暫時無法回答此問題，建議聯繫人工客服（LINE：@lios-support）。';
    }
    quickReplies = verdict === 'hold'
      ? ['提供更多資訊', '聯繫人工客服', '換一個問題']
      : ['聯繫人工客服', '換一個問題'];

    if (verdict === 'reject') {
      const ikey = makeIdempotencyKey(decision_id, 'chat.escalate');
      const result = await executeAction(
        decision_id,
        { action_type: 'chat.escalate', payload: { reason: analysis.intent_summary, tenant_id }, idempotency_key: ikey },
        tenant_id,
      );
      await writeLedger('action', result.action.id, 'action.created',
        { type: 'chat.escalate' }, tenant_id,
      ).catch(() => {});
    }
  }

  // Push reply to frontend via WebSocket — this is the key moment the user sees the reply
  pushProgress(trace_id, 'reply_ready', {
    reply:        replyText,
    quick_replies: quickReplies,
    verdict,
    session_id,
    trace_id,
  });

  // Push to ledger_queue
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
