import { query, queryOne } from '../db/client';
import { KernelResult } from './liKernel';
import { LiosDecision, DecisionType } from '../types/lios';

export const HOLD_LIMIT = 3;

interface RuntimeInput {
  intentId:  string;
  sessionId: string;
  tenantId:  string;
  packId:    string;
  kernel:    KernelResult;
  confidence: number;
}

interface RuntimeResult {
  decision:            LiosDecision;
  final_verdict:       DecisionType;
  hold_escalated:      boolean;
  session_hold_count:  number;
}

/**
 * Decision Runtime — 三态状态机
 *
 * hold 上限：同一 tenant + session 累计 hold 次数 >= HOLD_LIMIT → 自动升级为 reject
 */
export async function runDecisionRuntime(input: RuntimeInput): Promise<RuntimeResult> {
  const { intentId, sessionId, tenantId, packId, kernel, confidence } = input;

  // Hold count scoped to tenant + session (cross-tenant sessions don't affect each other)
  const holdRow = await queryOne<{ cnt: string }>(
    `SELECT COUNT(*)::text AS cnt
     FROM   lios_decisions d
     JOIN   lios_intents   i ON i.id = d.intent_id
     WHERE  i.session_id    = $1
       AND  i.tenant_id     = $2
       AND  d.decision_type = 'hold'`,
    [sessionId, tenantId]
  );
  const sessionHoldCount = parseInt(holdRow?.cnt ?? '0', 10);

  let finalVerdict: DecisionType = kernel.verdict as DecisionType;
  let holdEscalated = false;

  if (kernel.verdict === 'hold' && sessionHoldCount >= HOLD_LIMIT) {
    finalVerdict  = 'reject';
    holdEscalated = true;
  }

  const rationale = holdEscalated
    ? `session 内 hold 次数已达上限 ${HOLD_LIMIT} 次，自动升级为 reject`
    : kernel.reason;

  const [decision] = await query<LiosDecision>(
    `INSERT INTO lios_decisions
       (intent_id, pack_id, decision_type, rationale, confidence, hold_count, metadata, tenant_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      intentId,
      packId,
      finalVerdict,
      rationale,
      confidence,
      finalVerdict === 'hold' ? sessionHoldCount + 1 : 0,
      JSON.stringify({
        kernel_score:       kernel.kernel_score,
        kernel_verdict:     kernel.verdict,
        session_hold_count: sessionHoldCount,
        hold_escalated:     holdEscalated,
        evidence_summary:   kernel.evidence_summary,
      }),
      tenantId,
    ]
  );

  return { decision, final_verdict: finalVerdict, hold_escalated: holdEscalated, session_hold_count: sessionHoldCount };
}
