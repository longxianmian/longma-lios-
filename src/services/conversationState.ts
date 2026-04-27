/**
 * Conversation 状态：每个 chat session_id 一行。
 * 跨轮记忆当前进行中的业务流程 + 已收集 / 还缺的 slot。
 */

import { query, queryOne } from '../db/client';

export interface ConversationState {
  session_id:        string;
  tenant_id:         string;
  current_flow:      string | null;
  current_intent:    string | null;
  collected_slots:   Record<string, string>;
  missing_slots:     string[];
  hold_round:        number;
  last_intent_text:  string | null;
  status:            'active' | 'completed' | 'abandoned' | 'escalated';
  escalated_at:      string | null;
  escalation_reason: string | null;
  handoff_payload:   Record<string, unknown> | null;
  created_at:        string;
  updated_at:        string;
}

export async function getState(session_id: string): Promise<ConversationState | null> {
  const row = await queryOne<ConversationState>(
    `SELECT * FROM lios_conversation_states WHERE session_id = $1`,
    [session_id],
  ).catch(() => null);
  return row;
}

export async function upsertState(input: {
  session_id:       string;
  tenant_id:        string;
  current_flow:     string | null;
  current_intent:   string | null;
  collected_slots:  Record<string, string>;
  missing_slots:    string[];
  hold_round:       number;
  last_intent_text: string;
  status:           'active' | 'completed' | 'abandoned';
}): Promise<ConversationState> {
  const row = await queryOne<ConversationState>(
    `INSERT INTO lios_conversation_states
       (session_id, tenant_id, current_flow, current_intent, collected_slots, missing_slots, hold_round, last_intent_text, status)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9)
     ON CONFLICT (session_id) DO UPDATE
       SET tenant_id        = EXCLUDED.tenant_id,
           current_flow     = EXCLUDED.current_flow,
           current_intent   = EXCLUDED.current_intent,
           collected_slots  = EXCLUDED.collected_slots,
           missing_slots    = EXCLUDED.missing_slots,
           hold_round       = EXCLUDED.hold_round,
           last_intent_text = EXCLUDED.last_intent_text,
           status           = EXCLUDED.status,
           updated_at       = now()
     RETURNING *`,
    [
      input.session_id, input.tenant_id,
      input.current_flow, input.current_intent,
      JSON.stringify(input.collected_slots),
      JSON.stringify(input.missing_slots),
      input.hold_round,
      input.last_intent_text,
      input.status,
    ],
  );
  if (!row) throw new Error('upsert conversation state failed');
  return row;
}

export async function clearState(session_id: string): Promise<void> {
  await query(
    `UPDATE lios_conversation_states SET status='abandoned', updated_at=now() WHERE session_id=$1`,
    [session_id],
  ).catch(() => {});
}

export function emptyState(session_id: string, tenant_id: string): ConversationState {
  return {
    session_id, tenant_id,
    current_flow:     null,
    current_intent:   null,
    collected_slots:  {},
    missing_slots:    [],
    hold_round:       0,
    last_intent_text: null,
    status:           'active',
    escalated_at:     null,
    escalation_reason: null,
    handoff_payload:  null,
    created_at:       new Date().toISOString(),
    updated_at:       new Date().toISOString(),
  };
}

// ── escalation 入口守卫所需的轻量查询 ──────────────────────────────
export interface EscalationGuardSnapshot {
  status:            'active' | 'completed' | 'abandoned' | 'escalated';
  escalated_at:      string | null;
  escalation_reason: string | null;
}

/** chat.ts 入口在 preKernel 之前调；status='escalated' 时直接拦截 */
export async function getEscalationStatus(session_id: string): Promise<EscalationGuardSnapshot | null> {
  const row = await queryOne<EscalationGuardSnapshot>(
    `SELECT status, escalated_at, escalation_reason
       FROM lios_conversation_states
      WHERE session_id = $1`,
    [session_id],
  ).catch(() => null);
  return row;
}

/** verdict=-2 触发：写入 status='escalated' + handoff_payload，作为下一轮守卫依据 */
export async function markEscalated(opts: {
  session_id:        string;
  tenant_id:         string;
  reason:            string;
  handoff_payload?:  Record<string, unknown> | null;
}): Promise<void> {
  await query(
    `INSERT INTO lios_conversation_states
       (session_id, tenant_id, status, escalated_at, escalation_reason, handoff_payload, last_intent_text)
     VALUES ($1, $2, 'escalated', now(), $3, $4::jsonb, NULL)
     ON CONFLICT (session_id) DO UPDATE
       SET status            = 'escalated',
           escalated_at      = COALESCE(lios_conversation_states.escalated_at, now()),
           escalation_reason = COALESCE(EXCLUDED.escalation_reason, lios_conversation_states.escalation_reason),
           handoff_payload   = COALESCE(EXCLUDED.handoff_payload,   lios_conversation_states.handoff_payload),
           updated_at        = now()`,
    [
      opts.session_id, opts.tenant_id, opts.reason,
      opts.handoff_payload ? JSON.stringify(opts.handoff_payload) : null,
    ],
  ).catch(err => console.error('[markEscalated]', err));
}

/** 仅由 agent 端调（POST /lios/agent/sessions/:id/status to completed/transferred 时联动） */
export async function releaseEscalation(session_id: string, newStatus: 'completed' | 'active'): Promise<void> {
  await query(
    `UPDATE lios_conversation_states
        SET status = $2,
            updated_at = now()
      WHERE session_id = $1 AND status = 'escalated'`,
    [session_id, newStatus],
  ).catch(err => console.error('[releaseEscalation]', err));
}
