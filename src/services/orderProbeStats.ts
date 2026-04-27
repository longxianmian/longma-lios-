/**
 * 同一会话同一订单号的 not_found 累计计数
 * 来源：lios_ledgers payload->verifications_performed[*] 中 result='not_found' 的 input
 *
 * preKernel 据此升级 instruction：1 次 → 提示确认完整；2 次 → 要求手机/日期/渠道；3 次 → 自动 escalation。
 */

import { query } from '../db/client';

export type NotFoundAttempts = Record<string, number>;

export async function getOrderNotFoundAttempts(
  session_id: string,
  tenant_id:  string,
): Promise<NotFoundAttempts> {
  const rows = await query<{ verifs: unknown }>(
    `SELECT l.payload->'verifications_performed' AS verifs
       FROM lios_ledgers l
       JOIN lios_actions   a ON a.id = l.entity_id
       JOIN lios_decisions d ON d.id = a.decision_id
       JOIN lios_intents   i ON i.id = d.intent_id
      WHERE i.session_id = $1
        AND i.tenant_id  = $2
        AND l.event_type IN ('action.created','action.idempotent_hit')
        AND l.payload->>'source' = 'unified_llm_v3_pre_kernel'
        AND l.payload->'verifications_performed' IS NOT NULL`,
    [session_id, tenant_id],
  ).catch(() => []);

  const counter: NotFoundAttempts = {};
  for (const r of rows) {
    const arr = Array.isArray(r.verifs) ? r.verifs : [];
    for (const v of arr as Array<{ type?: string; input?: string; result?: string }>) {
      if (!v) continue;
      if (v.type === 'order' && v.result === 'not_found' && typeof v.input === 'string' && v.input.length > 0) {
        counter[v.input] = (counter[v.input] ?? 0) + 1;
      }
    }
  }
  return counter;
}

export function summarizeAttemptsForPrompt(attempts: NotFoundAttempts): string {
  const entries = Object.entries(attempts);
  if (entries.length === 0) return '';
  const lines = entries.map(([oid, n]) => `  - 訂單號 ${oid}：已查 ${n} 次，皆 not_found`);
  return `\n本會話歷史 not_found 累計：\n${lines.join('\n')}`;
}
