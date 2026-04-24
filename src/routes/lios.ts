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
  LiosAsset,
  LedgerEvent,
  DecisionType,
  ActionStatus,
  AssetScope,
} from '../types/lios';

// ── Tenant helper ─────────────────────────────────────────────────────────────

function resolveTenant(tid?: string): string {
  return (tid ?? 'default').trim() || 'default';
}

// ── Ledger helper ─────────────────────────────────────────────────────────────

let ledgerCount = 0;

async function ledger(
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
  ledgerCount++;
}

// ── Evidence factory ──────────────────────────────────────────────────────────

interface EvidenceDef {
  type:        string;
  source:      string;
  content:     string;
  trust_level: 'L1' | 'L2' | 'L3' | 'L4';
  weight:      number;
}

function buildEvidenceDefs(rawInput: string, context: Record<string, unknown>): EvidenceDef[] {
  // _test_force_l4=true → all evidence L4 (triggers kernel reject)
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

// ── Pack factory ──────────────────────────────────────────────────────────────

// _test_pack_score overrides the best pack score to exercise hold/reject paths
function buildMockPackDefs(context: Record<string, unknown>) {
  const override = typeof context._test_pack_score === 'number'
    ? (context._test_pack_score as number)
    : null;
  return [
    { name: 'direct-execution', description: '最短路径直接执行，适用于明确低风险任务', score: override ?? 0.85 },
    { name: 'staged-rollout',   description: '分阶段推进，关键节点可验证',             score: 0.72 },
    { name: 'human-in-loop',    description: '关键节点人工确认，高影响决策优先',       score: 0.60 },
  ];
}

// Scope → candidate score
const SCOPE_SCORE: Record<AssetScope, number> = {
  task:       0.86,
  project:    0.82,
  enterprise: 0.78,
  role:       0.75,
  industry:   0.70,
};

// ── Intent status mapping ─────────────────────────────────────────────────────

function intentStatus(verdict: DecisionType) {
  return verdict === 'accept' ? 'accepted' : verdict === 'hold' ? 'held' : 'rejected';
}

// ── Route registration ────────────────────────────────────────────────────────

export async function liosRoutes(app: FastifyInstance) {

  // ══ POST /lios/run ═══════════════════════════════════════════════════════
  app.post<{ Body: RunRequest }>('/lios/run', {
    schema: {
      body: {
        type: 'object',
        required: ['intent'],
        properties: {
          tenant_id:  { type: 'string' },
          intent:     { type: 'string', minLength: 1, maxLength: 4000 },
          session_id: { type: 'string' },
          context:    { type: 'object' },
        },
      },
    },
  }, async (req, reply) => {
    ledgerCount = 0;
    const { intent: rawInput, session_id, context = {} } = req.body;
    const tenantId  = resolveTenant(req.body.tenant_id);
    const sessionId = session_id ?? uuidv4();

    // ── Phase 1: Create Intent ─────────────────────────────────────────────
    const parsedGoal = {
      summary:     rawInput.slice(0, 200),
      token_count: rawInput.trim().split(/\s+/).length,
      keywords:    rawInput.trim().split(/\s+/).slice(0, 10),
      context,
    };

    const [intent] = await query<LiosIntent>(
      `INSERT INTO lios_intents (session_id, raw_input, parsed_goal, status, tenant_id)
       VALUES ($1, $2, $3, 'processing', $4)
       RETURNING *`,
      [sessionId, rawInput, JSON.stringify(parsedGoal), tenantId]
    );
    await ledger('intent', intent.id, 'intent.created',
      { session_id: sessionId, trace_id: intent.trace_id, tenant_id: tenantId }, tenantId);

    // ── Phase 2: Build CandidatePacks ─────────────────────────────────────
    // 2a. Mock rule packs
    const packRows: LiosCandidatePack[] = [];

    for (const def of buildMockPackDefs(context)) {
      const [pack] = await query<LiosCandidatePack>(
        `INSERT INTO lios_candidate_packs
           (intent_id, tenant_id, name, description, score, state, source_type)
         VALUES ($1, $2, $3, $4, $5, '-1', 'mock_rule')
         RETURNING *`,
        [intent.id, tenantId, def.name, def.description, def.score]
      );
      packRows.push(pack);
      await ledger('pack', pack.id, 'pack.created',
        { name: def.name, score: def.score, source_type: 'mock_rule' }, tenantId);
    }

    // 2b. Asset-based packs (indexed assets → Candidate Space)
    const assetPacks = await query<LiosAsset>(
      `SELECT * FROM lios_assets
       WHERE tenant_id = $1 AND is_indexed = TRUE
       ORDER BY CASE scope
         WHEN 'task' THEN 1 WHEN 'project' THEN 2 WHEN 'enterprise' THEN 3
         WHEN 'role' THEN 4 WHEN 'industry' THEN 5 ELSE 6 END
       LIMIT 5`,
      [tenantId]
    );

    for (const asset of assetPacks) {
      const assetScore = SCOPE_SCORE[asset.scope as AssetScope] ?? 0.70;
      // Use scope + id prefix for a stable, encoding-safe name
      const assetName  = `asset-${asset.scope}-${asset.id.slice(0, 8)}`;
      const [pack] = await query<LiosCandidatePack>(
        `INSERT INTO lios_candidate_packs
           (intent_id, tenant_id, name, description, score, state, source_type, metadata)
         VALUES ($1, $2, $3, $4, $5, '-1', 'asset', $6)
         RETURNING *`,
        [intent.id, tenantId, assetName, asset.content.slice(0, 300),
         assetScore, JSON.stringify({ asset_id: asset.id, scope: asset.scope, scope_ref: asset.scope_ref })]
      );
      packRows.push(pack);
      await ledger('pack', pack.id, 'pack.created',
        { name: assetName, score: assetScore, source_type: 'asset', asset_id: asset.id }, tenantId);
    }

    // ── Phase 3: Build Evidence ────────────────────────────────────────────
    // 3a. Mock evidence
    const evidenceDefs = buildEvidenceDefs(rawInput, context);
    const evidenceRows: LiosEvidenceItem[] = [];

    for (const ev of evidenceDefs) {
      const [evRow] = await query<LiosEvidenceItem>(
        `INSERT INTO lios_evidence_items
           (type, source, content, trust_level, weight, tenant_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [ev.type, ev.source, ev.content, ev.trust_level, ev.weight, tenantId]
      );
      evidenceRows.push(evRow);
      await ledger('evidence', evRow.id, 'evidence.added',
        { trust_level: ev.trust_level, weight: ev.weight, source: ev.source }, tenantId);

      for (const pack of packRows) {
        await query(
          `INSERT INTO lios_evidence_pack_index (pack_id, evidence_id, relevance_score)
           VALUES ($1, $2, $3)
           ON CONFLICT (pack_id, evidence_id) DO NOTHING`,
          [pack.id, evRow.id, ev.weight]
        );
      }
    }

    // 3b. Knowledge/policy assets → additional evidence (L2 trust)
    const knowledgeAssets = await query<LiosAsset>(
      `SELECT * FROM lios_assets
       WHERE tenant_id = $1 AND is_indexed = TRUE
         AND asset_type IN ('knowledge', 'policy')
       LIMIT 3`,
      [tenantId]
    );

    for (const asset of knowledgeAssets) {
      const [evRow] = await query<LiosEvidenceItem>(
        `INSERT INTO lios_evidence_items
           (type, source, content, trust_level, weight, tenant_id)
         VALUES ('fact', $1, $2, 'L2', 0.85, $3)
         RETURNING *`,
        [`asset:${asset.scope}:${asset.scope_ref || asset.name}`, asset.content.slice(0, 300), tenantId]
      );
      evidenceRows.push(evRow);
      await ledger('evidence', evRow.id, 'evidence.added',
        { trust_level: 'L2', weight: 0.85, source: `asset:${asset.scope}`, asset_id: asset.id }, tenantId);

      for (const pack of packRows) {
        await query(
          `INSERT INTO lios_evidence_pack_index (pack_id, evidence_id, relevance_score)
           VALUES ($1, $2, $3)
           ON CONFLICT (pack_id, evidence_id) DO NOTHING`,
          [pack.id, evRow.id, 0.85]
        );
      }
    }

    // ── Phase 4: LI Kernel scoring ─────────────────────────────────────────
    const kernelResult = runKernel(
      packRows.map(p  => ({ id: p.id, name: p.name, score: Number(p.score) })),
      evidenceRows.map(e => ({ id: e.id, trust_level: e.trust_level, weight: Number(e.weight) }))
    );

    await ledger('intent', intent.id, 'kernel.scored', {
      verdict:          kernelResult.verdict,
      kernel_score:     kernelResult.kernel_score,
      reason:           kernelResult.reason,
      evidence_summary: kernelResult.evidence_summary,
      total_packs:      packRows.length,
    }, tenantId);

    // ── Phase 5: Decision Runtime (三态 + hold 超限 reject) ────────────────
    const { decision, final_verdict, hold_escalated, session_hold_count } =
      await runDecisionRuntime({
        intentId:   intent.id,
        sessionId,
        tenantId,
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
      tenant_id:          tenantId,
    }, tenantId);

    // Update pack states
    await query(`UPDATE lios_candidate_packs SET state='1' WHERE id=$1`, [kernelResult.selected_pack_id]);
    await query(
      `UPDATE lios_candidate_packs SET state='0' WHERE intent_id=$1 AND id!=$2`,
      [intent.id, kernelResult.selected_pack_id]
    );

    // ── Phase 6: Executor — 幂等 Actions (accept only) ────────────────────
    const executorResults: Array<{
      id:              string;
      type:            string;
      idempotency_key: string;
      status:          ActionStatus;
      is_new:          boolean;
      payload:         Record<string, unknown>;
    }> = [];

    if (final_verdict === 'accept') {
      const actionSpecs = [
        {
          action_type: 'orchestrate.pack',
          payload:     { pack_id: kernelResult.selected_pack_id, pack_name: kernelResult.selected_pack_name },
        },
        {
          action_type: 'emit.event',
          payload:     { event: 'lios.accept', trace_id: intent.trace_id, session_id: sessionId, tenant_id: tenantId },
        },
        {
          action_type: 'audit.snapshot',
          payload:     { intent_id: intent.id, kernel_score: kernelResult.kernel_score, evidence_count: evidenceRows.length, tenant_id: tenantId },
        },
      ];

      for (const spec of actionSpecs) {
        const ikey   = makeIdempotencyKey(decision.id, spec.action_type);
        const result = await executeAction(decision.id, { ...spec, idempotency_key: ikey }, tenantId);

        const evType: LedgerEvent = result.is_new ? 'action.created' : 'action.idempotent_hit';
        await ledger('action', result.action.id, evType, { type: spec.action_type, idempotency_key: ikey, is_new: result.is_new }, tenantId);
        if (result.is_new) {
          await ledger('action', result.action.id, 'action.executed', { result: 'ok' }, tenantId);
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

    // ── Phase 7: Close Intent ─────────────────────────────────────────────
    const finalStatus = intentStatus(final_verdict);
    await query(
      `UPDATE lios_intents SET status=$1, updated_at=NOW() WHERE id=$2`,
      [finalStatus, intent.id]
    );
    await ledger('intent', intent.id, 'ledger.closed', {
      final_state:    finalStatus,
      trace_id:       intent.trace_id,
      actions_count:  executorResults.length,
      ledger_entries: ledgerCount + 1,
      tenant_id:      tenantId,
    }, tenantId);

    // ── Response ──────────────────────────────────────────────────────────
    const response: RunResponse & { tenant_id: string } = {
      trace_id:    intent.trace_id,
      intent_id:   intent.id,
      session_id:  sessionId,
      tenant_id:   tenantId,
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

  // ══ GET /lios/intent/:id ═════════════════════════════════════════════════
  app.get<{
    Params:      { id: string };
    Querystring: { tenant_id?: string };
  }>('/lios/intent/:id', async (req, reply) => {
    const { id }       = req.params;
    const tenantId     = resolveTenant(req.query.tenant_id);

    const [intent] = await query<LiosIntent>(
      `SELECT * FROM lios_intents WHERE id=$1 AND tenant_id=$2`, [id, tenantId]
    );
    if (!intent) return reply.code(404).send({ error: 'intent not found' });

    const packs     = await query<LiosCandidatePack>(
      `SELECT * FROM lios_candidate_packs WHERE intent_id=$1 AND tenant_id=$2 ORDER BY score DESC`, [id, tenantId]
    );
    const decisions = await query<LiosDecision>(
      `SELECT * FROM lios_decisions WHERE intent_id=$1 AND tenant_id=$2 ORDER BY created_at`, [id, tenantId]
    );
    const actions = decisions.length
      ? await query<LiosAction>(
          `SELECT * FROM lios_actions WHERE decision_id=ANY($1::uuid[]) ORDER BY created_at`,
          [decisions.map(d => d.id)]
        )
      : [];
    const ledgers = await query<LiosLedger>(
      `SELECT * FROM lios_ledgers
       WHERE tenant_id=$1
         AND (
           entity_id=$2
           OR entity_id IN (SELECT id FROM lios_decisions WHERE intent_id=$2 AND tenant_id=$1)
           OR entity_id IN (
             SELECT a.id FROM lios_actions a
             JOIN lios_decisions d ON a.decision_id=d.id
             WHERE d.intent_id=$2 AND d.tenant_id=$1
           )
         )
       ORDER BY created_at`,
      [tenantId, id]
    );

    return reply.code(200).send({ intent, packs, decisions, actions, ledger_entries: ledgers });
  });

  // ══ GET /lios/session/:session_id ════════════════════════════════════════
  app.get<{
    Params:      { session_id: string };
    Querystring: { tenant_id?: string };
  }>('/lios/session/:session_id', async (req, reply) => {
    const { session_id } = req.params;
    const tenantId       = resolveTenant(req.query.tenant_id);

    const intents = await query<LiosIntent & { decision_type: string | null; confidence: number | null }>(
      `SELECT i.*, d.decision_type, d.confidence
         FROM lios_intents    i
         LEFT JOIN lios_decisions d ON d.intent_id = i.id
        WHERE i.session_id = $1 AND i.tenant_id = $2
        ORDER BY i.created_at DESC`,
      [session_id, tenantId]
    );

    return reply.code(200).send({
      session_id,
      tenant_id:    tenantId,
      intent_count: intents.length,
      hold_count:   intents.filter(i => i.decision_type === 'hold').length,
      intents,
    });
  });
}
