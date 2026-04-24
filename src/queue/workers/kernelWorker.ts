import { query } from '../../db/client';
import { writeLedger } from '../../db/ledger';
import { LLMAnalysis } from '../../services/llm';
import { runKernel } from '../../kernel/liKernel';
import { runDecisionRuntime } from '../../kernel/decisionRuntime';
import { pushProgress } from '../../ws/server';
import { consumeGroup, ackMsg, pushToQueue, QUEUES, GROUPS } from '../streams';
import {
  LiosIntent, LiosCandidatePack, LiosEvidenceItem,
} from '../../types/lios';

async function processKernel(fields: Record<string, string>): Promise<void> {
  const {
    trace_id, tenant_id, session_id, user_message, intent_id,
    analysis_json, kb_assets_json, kb_context, candidate_score,
  } = fields;

  pushProgress(trace_id, 'running_kernel', {});

  const analysis: LLMAnalysis = JSON.parse(analysis_json);
  const kbAssets: Array<{ id: string; name: string; content: string; asset_type: string }> =
    JSON.parse(kb_assets_json);
  const cscore = parseFloat(candidate_score);

  // ── Phase 4: CandidatePack ────────────────────────────────────────────────
  const [pack] = await query<LiosCandidatePack>(
    `INSERT INTO lios_candidate_packs
       (intent_id, tenant_id, name, description, score, state, source_type, metadata)
     VALUES ($1, $2, $3, $4, $5, '-1', 'llm', $6)
     RETURNING *`,
    [
      intent_id, tenant_id,
      `llm-reply-${intent_id.slice(0, 8)}`,
      analysis.intent_summary.slice(0, 300),
      cscore,
      JSON.stringify({ model: 'gpt-4o-mini', intent_type: analysis.intent_type }),
    ],
  );

  await writeLedger('pack', pack.id, 'pack.created',
    { source_type: 'llm', score: cscore, intent_type: analysis.intent_type }, tenant_id,
  ).catch(() => {});

  // ── Phase 5: Evidence ─────────────────────────────────────────────────────
  const evidenceRows: LiosEvidenceItem[] = [];

  if (analysis.out_of_scope || analysis.confidence < 0.5) {
    for (const [label, content] of [
      ['out_of_scope_signal', `意圖分類：${analysis.intent_type}，置信度：${analysis.confidence}，超出業務範圍`],
      ['no_kb_match',         `知識庫未找到相關內容，無法支持此回覆`],
    ] as [string, string][]) {
      const [ev] = await query<LiosEvidenceItem>(
        `INSERT INTO lios_evidence_items
           (tenant_id, type, source, content, trust_level, weight)
         VALUES ($1, 'signal', $2, $3, 'L4', 0.40) RETURNING *`,
        [tenant_id, label, content],
      );
      evidenceRows.push(ev);
      await query(
        `INSERT INTO lios_evidence_pack_index (pack_id, evidence_id, relevance_score)
         VALUES ($1, $2, 0.40) ON CONFLICT (pack_id, evidence_id) DO NOTHING`,
        [pack.id, ev.id],
      );
    }
  } else {
    const [sessionEv] = await query<LiosEvidenceItem>(
      `INSERT INTO lios_evidence_items
         (tenant_id, type, source, content, trust_level, weight)
       VALUES ($1, 'fact', 'session_context', $2, 'L2', 0.85) RETURNING *`,
      [tenant_id, `session=${session_id} intent=${analysis.intent_type} valid`],
    );
    evidenceRows.push(sessionEv);
    await query(
      `INSERT INTO lios_evidence_pack_index (pack_id, evidence_id, relevance_score)
       VALUES ($1, $2, 0.85) ON CONFLICT (pack_id, evidence_id) DO NOTHING`,
      [pack.id, sessionEv.id],
    );

    for (const asset of kbAssets) {
      const [ev] = await query<LiosEvidenceItem>(
        `INSERT INTO lios_evidence_items
           (tenant_id, type, source, content, trust_level, weight)
         VALUES ($1, 'fact', $2, $3, 'L3', 0.80) RETURNING *`,
        [tenant_id, `kb:${asset.asset_type}:${asset.id}`, asset.content.slice(0, 300)],
      );
      evidenceRows.push(ev);
      await query(
        `INSERT INTO lios_evidence_pack_index (pack_id, evidence_id, relevance_score)
         VALUES ($1, $2, 0.80) ON CONFLICT (pack_id, evidence_id) DO NOTHING`,
        [pack.id, ev.id],
      );
      await writeLedger('evidence', ev.id, 'evidence.added',
        { trust_level: 'L3', asset_id: asset.id }, tenant_id,
      ).catch(() => {});
    }
  }

  // ── Phase 6: LI Kernel ────────────────────────────────────────────────────
  const kernelResult = runKernel(
    [{ id: pack.id, name: pack.name, score: Number(pack.score) }],
    evidenceRows.map(e => ({ id: e.id, trust_level: e.trust_level, weight: Number(e.weight) })),
  );

  await writeLedger('intent', intent_id, 'kernel.scored', {
    verdict: kernelResult.verdict, kernel_score: kernelResult.kernel_score,
    reason: kernelResult.reason,
  }, tenant_id).catch(() => {});

  // ── Phase 7: Decision Runtime ──────────────────────────────────────────────
  const { decision, final_verdict, hold_escalated, session_hold_count } =
    await runDecisionRuntime({
      intentId: intent_id, sessionId: session_id, tenantId: tenant_id,
      packId: pack.id, kernel: kernelResult, confidence: cscore,
    });

  await writeLedger('decision', decision.id,
    hold_escalated ? 'decision.hold_escalated' : 'decision.made',
    { type: final_verdict, hold_count: decision.hold_count, tenant_id }, tenant_id,
  ).catch(() => {});

  // ── Hallucination guard ───────────────────────────────────────────────────
  let hallucination_guard = false;
  let guarded_verdict = final_verdict;

  if (final_verdict === 'accept' && kbAssets.length === 0) {
    hallucination_guard = true;
    guarded_verdict     = 'hold';
    await writeLedger('intent', intent_id, 'kernel.scored',
      { hallucination_guard: true, reason: 'accept→hold: KB empty' }, tenant_id,
    ).catch(() => {});
  }

  await query(
    `UPDATE lios_candidate_packs SET state=$1 WHERE id=$2`,
    [guarded_verdict === 'accept' ? '1' : '0', pack.id],
  ).catch(() => {});

  // Stage
  pushProgress(trace_id, 'kernel_decided', {
    verdict: guarded_verdict, kernel_score: kernelResult.kernel_score,
    hold_escalated, hallucination_guard,
  });

  // ── Push to reply_queue ────────────────────────────────────────────────────
  await pushToQueue(QUEUES.REPLY, {
    trace_id, tenant_id, session_id, user_message, intent_id,
    analysis_json,
    kb_context,
    decision_id:        decision.id,
    pack_id:            pack.id,
    guarded_verdict,
    final_verdict,
    hallucination_guard: String(hallucination_guard),
    candidate_score,
  });
}

let _running = false;

export async function startKernelWorker(): Promise<void> {
  if (_running) return;
  _running = true;
  console.log('[Worker:kernel] started');

  while (_running) {
    try {
      const msgs = await consumeGroup(QUEUES.DECISION, GROUPS.DECISION, 'kernel-1');
      for (const { id, fields } of msgs) {
        try {
          await processKernel(fields);
        } catch (err) {
          console.error('[Worker:kernel] processing error:', err);
          if (fields.trace_id) pushProgress(fields.trace_id, 'error', { message: String(err) });
        } finally {
          await ackMsg(QUEUES.DECISION, GROUPS.DECISION, id);
        }
      }
    } catch (err) {
      if (!(err as Error).message?.includes('NOGROUP')) console.error('[Worker:kernel] loop error:', err);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

export function stopKernelWorker(): void { _running = false; }
