import { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../db/client';
import { runKernel } from '../kernel/liKernel';
import { runDecisionRuntime } from '../kernel/decisionRuntime';
import { executeAction, makeIdempotencyKey } from '../kernel/executor';
import {
  RunRequest,
  RunResponse,
  LiosIntent,
  LiosCandidatePack,
  LiosEvidenceItem,
  LiosDecision,
  LiosAction,
  LiosLedger,
  LedgerEvent,
  DecisionType,
  ActionStatus,
} from '../types/lios';

// ── Ledger helper ────────────────────────────────────────────────────────────

let ledgerCount = 0;

async function ledger(
  entityType: string,
  entityId: string,
  eventType: LedgerEvent,
  payload: Record<string, unknown>
): Promise<void> {
  await query(
    `INSERT INTO lios_ledgers (entity_type, entity_id, event_type, payload)
     VALUES ($1, $2, $3, $4)`,
    [entityType, entityId, eventType, JSON.stringify(payload)]
  );
  ledgerCount++;
}

// ── Mock evidence factory (mock_rule source) ──────────────────────────────────

interface EvidenceDef {
  type: string;
  source: string;
  content: string;
  trust_level: 'L1' | 'L2' | 'L3' | 'L4';
  weight: number;
}

function buildEvidenceDefs(rawInput: string, context: Record<string, unknown>): EvidenceDef[] {
  // _test_force_l4=true → all evidence becomes L4 (triggers kernel reject)
  const forceL4 = context._test_force_l4 === true;
  return [
    {
      type:        'rule',
      source:      'mock_rule_engine',
      content:     `主推理规则匹配：「${rawInput.slice(0, 80)}」`,
      trust_level: forceL4 ? 'L4' : 'L1',
      weight:      0.95,
    },
    {
      type:        'signal',
      source:      'mock_rule_engine',
      content:     '输入信号强度满足执行阈值 (intent length OK)',
      trust_level: forceL4 ? 'L4' : 'L2',
      weight:      0.85,
    },
    {
      type:        'fact',
      source:      'context_parser',
      content:     `上下文字段数：${Object.keys(context).length}，session 就绪`,
      trust_level: forceL4 ? 'L4' : 'L2',
      weight:      0.82,
    },
    {
      type:        'constraint',
      source:      'policy_engine',
      content:     '速率限制：每分钟 ≤ 100 次推理，当前未超限',
      trust_level: forceL4 ? 'L4' : 'L3',
      weight:      0.70,
    },
  ];
}

// ── Candidate pack factory ────────────────────────────────────────────────────

// _test_pack_score overrides the best pack's score (e.g. 0.60 forces hold)
function buildPackDefs(context: Record<string, unknown>) {
  const override = typeof context._test_pack_score === 'number'
    ? (context._test_pack_score as number)
    : null;
  return [
    { name: 'direct-execution', description: '最短路径直接执行，适用于明确低风险任务', score: override ?? 0.85 },
    { name: 'staged-rollout',   description: '分阶段推进，关键节点可验证',             score: 0.72 },
    { name: 'human-in-loop',    description: '关键节点人工确认，高影响决策优先',       score: 0.60 },
  ];
}

// ── Intent status mapping ─────────────────────────────────────────────────────

function intentStatus(verdict: DecisionType) {
  return verdict === 'accept' ? 'accepted' : verdict === 'hold' ? 'held' : 'rejected';
}

// ── Route ─────────────────────────────────────────────────────────────────────

export async function liosRoutes(app: FastifyInstance) {
  app.post<{ Body: RunRequest }>('/lios/run', {
    schema: {
      body: {
        type: 'object',
        required: ['intent'],
        properties: {
          intent:     { type: 'string', minLength: 1, maxLength: 4000 },
          session_id: { type: 'string' },
          context:    { type: 'object' },
        },
      },
    },
  }, async (req, reply) => {
    ledgerCount = 0;
    const { intent: rawInput, session_id, context = {} } = req.body;
    const sessionId = session_id ?? uuidv4();

    // ── Phase 1: Create Intent ───────────────────────────────────────────────
    const parsedGoal = {
      summary:     rawInput.slice(0, 200),
      token_count: rawInput.trim().split(/\s+/).length,
      keywords:    rawInput.trim().split(/\s+/).slice(0, 10),
      context,
    };

    const [intent] = await query<LiosIntent>(
      `INSERT INTO lios_intents (session_id, raw_input, parsed_goal, status)
       VALUES ($1, $2, $3, 'processing')
       RETURNING *`,
      [sessionId, rawInput, JSON.stringify(parsedGoal)]
    );
    await ledger('intent', intent.id, 'intent.created', { session_id: sessionId, trace_id: intent.trace_id });

    // ── Phase 2: Build CandidatePacks (state="-1", source_type="mock_rule") ──
    const packRows: LiosCandidatePack[] = [];
    for (const def of buildPackDefs(context)) {
      const [pack] = await query<LiosCandidatePack>(
        `INSERT INTO lios_candidate_packs
           (intent_id, name, description, score, state, source_type)
         VALUES ($1, $2, $3, $4, '-1', 'mock_rule')
         RETURNING *`,
        [intent.id, def.name, def.description, def.score]
      );
      packRows.push(pack);
      await ledger('pack', pack.id, 'pack.created', { name: def.name, score: def.score, state: '-1', source_type: 'mock_rule' });
    }

    // ── Phase 3: Build EvidencePack (trust_level, weight → lios_evidence_items) ──
    const evidenceDefs = buildEvidenceDefs(rawInput, context);
    const evidenceRows: LiosEvidenceItem[] = [];

    for (const ev of evidenceDefs) {
      const [evRow] = await query<LiosEvidenceItem>(
        `INSERT INTO lios_evidence_items
           (type, source, content, trust_level, weight)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [ev.type, ev.source, ev.content, ev.trust_level, ev.weight]
      );
      evidenceRows.push(evRow);
      await ledger('evidence', evRow.id, 'evidence.added', {
        trust_level: ev.trust_level, weight: ev.weight, source: ev.source,
      });

      // Index evidence against every candidate pack
      for (const pack of packRows) {
        await query(
          `INSERT INTO lios_evidence_pack_index (pack_id, evidence_id, relevance_score)
           VALUES ($1, $2, $3)
           ON CONFLICT (pack_id, evidence_id) DO NOTHING`,
          [pack.id, evRow.id, ev.weight]
        );
      }
    }

    // ── Phase 4: LI Kernel scoring ───────────────────────────────────────────
    const kernelResult = runKernel(
      packRows.map(p => ({ id: p.id, name: p.name, score: Number(p.score) })),
      evidenceRows.map(e => ({ id: e.id, trust_level: e.trust_level, weight: Number(e.weight) }))
    );

    await ledger('intent', intent.id, 'kernel.scored', {
      verdict:      kernelResult.verdict,
      kernel_score: kernelResult.kernel_score,
      reason:       kernelResult.reason,
      evidence_summary: kernelResult.evidence_summary,
    });

    // ── Phase 5: Decision Runtime (三态 + hold 超限自动 reject) ─────────────
    const { decision, final_verdict, hold_escalated, session_hold_count } =
      await runDecisionRuntime({
        intentId:   intent.id,
        sessionId,
        packId:     kernelResult.selected_pack_id,
        kernel:     kernelResult,
        confidence: kernelResult.kernel_score,
      });

    const decisionEvent: LedgerEvent = hold_escalated ? 'decision.hold_escalated' : 'decision.made';
    await ledger('decision', decision.id, decisionEvent, {
      type:               final_verdict,
      hold_count:         decision.hold_count,
      hold_escalated,
      session_hold_count,
      selected_pack:      kernelResult.selected_pack_name,
    });

    // Update pack states: selected→'1', others→'0'
    await query(
      `UPDATE lios_candidate_packs SET state = '1' WHERE id = $1`,
      [kernelResult.selected_pack_id]
    );
    await query(
      `UPDATE lios_candidate_packs SET state = '0'
       WHERE intent_id = $1 AND id != $2`,
      [intent.id, kernelResult.selected_pack_id]
    );

    // ── Phase 6: Executor — 幂等执行 Actions (only on accept) ───────────────
    const executorResults: Array<{
      id: string; type: string; idempotency_key: string;
      status: ActionStatus; is_new: boolean; payload: Record<string, unknown>;
    }> = [];

    if (final_verdict === 'accept') {
      const actionSpecs = [
        {
          action_type: 'orchestrate.pack',
          payload:     { pack_id: kernelResult.selected_pack_id, pack_name: kernelResult.selected_pack_name },
        },
        {
          action_type: 'emit.event',
          payload:     { event: 'lios.accept', trace_id: intent.trace_id, session_id: sessionId },
        },
        {
          action_type: 'audit.snapshot',
          payload:     { intent_id: intent.id, kernel_score: kernelResult.kernel_score, evidence_count: evidenceRows.length },
        },
      ];

      for (const spec of actionSpecs) {
        const ikey   = makeIdempotencyKey(decision.id, spec.action_type);
        const result = await executeAction(decision.id, { ...spec, idempotency_key: ikey });

        const evType: LedgerEvent = result.is_new ? 'action.created' : 'action.idempotent_hit';
        await ledger('action', result.action.id, evType, {
          type:            spec.action_type,
          idempotency_key: ikey,
          is_new:          result.is_new,
        });
        if (result.is_new) {
          await ledger('action', result.action.id, 'action.executed', { result: 'ok' });
        }

        executorResults.push({
          id:              result.action.id,
          type:            result.action.action_type,
          idempotency_key: ikey,
          status:          result.action.status,
          is_new:          result.is_new,
          payload:         result.action.payload as Record<string, unknown>,
        });
      }
    }

    // ── Phase 7: Close Intent + final ledger entry ───────────────────────────
    const finalStatus = intentStatus(final_verdict);
    await query(
      `UPDATE lios_intents SET status = $1, updated_at = NOW() WHERE id = $2`,
      [finalStatus, intent.id]
    );
    await ledger('intent', intent.id, 'ledger.closed', {
      final_state:    finalStatus,
      trace_id:       intent.trace_id,
      actions_count:  executorResults.length,
      ledger_entries: ledgerCount + 1,   // +1 for this entry itself
    });

    // ── Response ─────────────────────────────────────────────────────────────
    const response: RunResponse = {
      trace_id:    intent.trace_id,
      intent_id:   intent.id,
      session_id:  sessionId,
      final_state: finalStatus as 'accepted' | 'rejected' | 'held',
      result: {
        kernel: {
          score:            kernelResult.kernel_score,
          verdict:          kernelResult.verdict,
          reason:           kernelResult.reason,
          selected_pack:    kernelResult.selected_pack_name,
          evidence_summary: kernelResult.evidence_summary,
        },
        decision: {
          id:         decision.id,
          type:       final_verdict,
          hold_count: decision.hold_count,
          rationale:  decision.rationale,
          confidence: Number(decision.confidence),
        },
        actions:        executorResults,
        ledger_entries: ledgerCount,
      },
      processed_at: new Date().toISOString(),
    };

    return reply.code(200).send(response);
  });

  // ── GET /lios/intent/:id — full intent snapshot ───────────────────────────
  app.get<{ Params: { id: string } }>('/lios/intent/:id', async (req, reply) => {
    const { id } = req.params;

    const [intent] = await query<LiosIntent>(
      `SELECT * FROM lios_intents WHERE id = $1`, [id]
    );
    if (!intent) return reply.code(404).send({ error: 'intent not found' });

    const packs = await query<LiosCandidatePack>(
      `SELECT * FROM lios_candidate_packs WHERE intent_id = $1 ORDER BY score DESC`, [id]
    );
    const decisions = await query<LiosDecision>(
      `SELECT * FROM lios_decisions WHERE intent_id = $1 ORDER BY created_at`, [id]
    );
    const actions = decisions.length
      ? await query<LiosAction>(
          `SELECT * FROM lios_actions WHERE decision_id = ANY($1::uuid[]) ORDER BY created_at`,
          [decisions.map(d => d.id)]
        )
      : [];
    const ledgers = await query<LiosLedger>(
      `SELECT * FROM lios_ledgers WHERE entity_id = $1
         OR entity_id IN (
           SELECT id FROM lios_decisions WHERE intent_id = $1
         )
         OR entity_id IN (
           SELECT a.id FROM lios_actions a
           JOIN lios_decisions d ON a.decision_id = d.id
           WHERE d.intent_id = $1
         )
       ORDER BY created_at`,
      [id]
    );

    return reply.code(200).send({ intent, packs, decisions, actions, ledger_entries: ledgers });
  });

  // ── GET /lios/session/:session_id — session history ───────────────────────
  app.get<{ Params: { session_id: string } }>('/lios/session/:session_id', async (req, reply) => {
    const { session_id } = req.params;

    const intents = await query<LiosIntent & { decision_type: string | null; confidence: number | null }>(
      `SELECT i.*,
              d.decision_type,
              d.confidence
         FROM lios_intents   i
         LEFT JOIN lios_decisions d ON d.intent_id = i.id
        WHERE i.session_id = $1
        ORDER BY i.created_at DESC`,
      [session_id]
    );

    const holdCount = intents.filter(i => i.decision_type === 'hold').length;

    return reply.code(200).send({
      session_id,
      intent_count:    intents.length,
      hold_count:      holdCount,
      intents,
    });
  });
}
