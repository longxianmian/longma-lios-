import { query } from '../db/client';
import { LiosAction } from '../types/lios';

export interface ActionSpec {
  action_type: string;
  payload: Record<string, unknown>;
  idempotency_key: string;
}

export interface ExecutorResult {
  action: LiosAction;
  is_new: boolean;
}

/**
 * 幂等 Executor
 *
 * 用 idempotency_key 唯一约束保证同一 key 的 action 只执行一次。
 * ON CONFLICT → 返回已存在记录（is_new=false），调用方不再重复执行。
 */
export async function executeAction(
  decisionId: string,
  spec: ActionSpec
): Promise<ExecutorResult> {
  const rows = await query<LiosAction & { _xmax: string }>(
    `INSERT INTO lios_actions
       (decision_id, action_type, payload, idempotency_key, status, executed_at)
     VALUES ($1, $2, $3, $4, 'done', NOW())
     ON CONFLICT (idempotency_key) DO UPDATE
       SET status = lios_actions.status   -- no-op update to return existing row
     RETURNING *, xmax::text AS _xmax`,
    [decisionId, spec.action_type, JSON.stringify(spec.payload), spec.idempotency_key]
  );

  const row    = rows[0];
  const is_new = row._xmax === '0';                // xmax=0 means newly inserted

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { _xmax: _x, ...action } = row;
  return { action: action as unknown as LiosAction, is_new };
}

/**
 * 构造幂等键：decision_id + action_type，保证同一次决策的同类动作全局唯一
 */
export function makeIdempotencyKey(decisionId: string, actionType: string): string {
  return `${decisionId}::${actionType}`;
}
