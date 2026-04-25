import { query } from '../../db/client';
import { writeLedger } from '../../db/ledger';
import { analyzeIntent } from '../../services/llm';
import { embedText, rankBySimilarity } from '../../services/embedding';
import { pushProgress } from '../../ws/server';
import { consumeGroup, ackMsg, pushToQueue, QUEUES, GROUPS } from '../streams';

async function processIntent(fields: Record<string, string>): Promise<void> {
  const { trace_id, tenant_id, session_id, user_message, intent_id } = fields;

  // Stage 1 — emit immediately so frontend shows first stage
  pushProgress(trace_id, 'analyzing_intent', {});

  // ── KB vector search ──────────────────────────────────────────────────────
  const kbAssets = await (async () => {
    const withVec = await query<{
      id: string; name: string; content: string; asset_type: string; embedding: number[];
    }>(
      `SELECT id, name, content, asset_type, embedding
       FROM lios_assets
       WHERE tenant_id=$1 AND is_indexed=TRUE AND embedding IS NOT NULL
         AND content NOT LIKE '[待转录：%'`,
      [tenant_id],
    ).catch(() => []);

    if (withVec.length > 0) {
      try {
        const qv = await embedText(user_message);
        return rankBySimilarity(qv, withVec, 5).filter(a => a.similarity > 0.3);
      } catch { /* fall through */ }
    }

    return query<{ id: string; name: string; content: string; asset_type: string }>(
      `SELECT id, name, content, asset_type
       FROM lios_assets
       WHERE tenant_id=$1 AND is_indexed=TRUE AND content NOT LIKE '[待转录：%'
       ORDER BY created_at DESC LIMIT 8`,
      [tenant_id],
    ).catch(() => []);
  })();

  // Stage 2 — KB search complete
  pushProgress(trace_id, 'searching_kb', { kb_count: kbAssets.length });

  const kbContext = kbAssets.length > 0
    ? `企業知識庫（已按相關性排序）：\n${kbAssets.map(a => `【${a.name}】\n${a.content.slice(0, 500)}`).join('\n\n')}`
    : '';

  // ── LLM intent analysis ────────────────────────────────────────────────────
  const analysis = await analyzeIntent(user_message, kbContext);

  const candidateScore = analysis.out_of_scope
    ? 0.10
    : Math.max(0, Math.min(1, analysis.confidence));

  // ── Update intent record ───────────────────────────────────────────────────
  await query(
    `UPDATE lios_intents
     SET parsed_goal=$1, status='processing', updated_at=NOW()
     WHERE id=$2`,
    [JSON.stringify({
      intent_type:    analysis.intent_type,
      intent_summary: analysis.intent_summary,
      confidence:     analysis.confidence,
      out_of_scope:   analysis.out_of_scope,
    }), intent_id],
  );

  await writeLedger('intent', intent_id, 'intent.created',
    { session_id, trace_id, tenant_id }, tenant_id,
  ).catch(() => {});

  // Stage — intent parsed (frontend transitions to "知识库检索中")
  pushProgress(trace_id, 'intent_parsed', {
    intent_type: analysis.intent_type,
    confidence:  analysis.confidence,
    kb_count:    kbAssets.length,
  });

  // ── Push to decision_queue ─────────────────────────────────────────────────
  await pushToQueue(QUEUES.DECISION, {
    trace_id,
    tenant_id,
    session_id,
    user_message,
    intent_id,
    analysis_json:   JSON.stringify(analysis),
    kb_assets_json:  JSON.stringify(kbAssets),
    kb_context: kbContext,
    candidate_score: String(candidateScore),
  });
}

let _running = false;

export async function startIntentWorker(): Promise<void> {
  if (_running) return;
  _running = true;
  console.log('[Worker:intent] started');

  while (_running) {
    try {
      const msgs = await consumeGroup(QUEUES.INTENT, GROUPS.INTENT, 'intent-1');
      for (const { id, fields } of msgs) {
        try {
          await processIntent(fields);
        } catch (err) {
          console.error('[Worker:intent] processing error:', err);
          if (fields.trace_id) {
            pushProgress(fields.trace_id, 'error', { message: String(err) });
          }
        } finally {
          await ackMsg(QUEUES.INTENT, GROUPS.INTENT, id);
        }
      }
    } catch (err) {
      if (!(err as Error).message?.includes('NOGROUP')) {
        console.error('[Worker:intent] loop error:', err);
      }
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

export function stopIntentWorker(): void { _running = false; }
