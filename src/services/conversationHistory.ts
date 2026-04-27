/**
 * 取最近 N 轮 user/bot 对话。
 * user 來源 lios_intents.raw_input；bot 來源 lios_actions.payload.reply（chat.reply 类型）。
 * 异常時返回空数组，不阻塞主流程。
 */

import { query } from '../db/client';

export interface ConversationTurn {
  role:    'user' | 'bot';
  content: string;
  ts:      string;
}

export async function getRecentHistory(
  session_id: string,
  tenant_id:  string,
  limit:      number = 10,
): Promise<ConversationTurn[]> {
  const rows = await query<{ ts: string; user_msg: string; bot_reply: string | null }>(
    `SELECT i.created_at AS ts,
            i.raw_input  AS user_msg,
            (SELECT a.payload->>'reply'
               FROM lios_actions a
               JOIN lios_decisions d ON d.id = a.decision_id
              WHERE d.intent_id = i.id
                AND a.action_type = 'chat.reply'
              ORDER BY a.executed_at DESC LIMIT 1) AS bot_reply
       FROM lios_intents i
      WHERE i.session_id = $1 AND i.tenant_id = $2
      ORDER BY i.created_at DESC
      LIMIT $3`,
    [session_id, tenant_id, limit],
  ).catch(() => []);

  // rows 是降序，整理成升序的 (user, bot) 对
  const turns: ConversationTurn[] = [];
  for (const r of rows.slice().reverse()) {
    if (r.user_msg) turns.push({ role: 'user', content: r.user_msg, ts: r.ts });
    if (r.bot_reply) turns.push({ role: 'bot',  content: r.bot_reply, ts: r.ts });
  }
  return turns;
}

export function formatHistoryForPrompt(turns: ConversationTurn[], maxChars = 1200): string {
  if (turns.length === 0) return '（無）';
  const lines: string[] = [];
  for (const t of turns) {
    const tag = t.role === 'user' ? '用戶' : '客服';
    lines.push(`${tag}：${t.content.slice(0, 200)}`);
  }
  let s = lines.join('\n');
  if (s.length > maxChars) s = '…\n' + s.slice(-maxChars);
  return s;
}
