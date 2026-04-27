/**
 * Helpers for creating + appending to agent sessions (human handoff).
 * Called from replyWorker when verdict is reject/hold; also called by the agent desk
 * REST routes when humans send replies.
 */

import { query, queryOne } from '../db/client';
import { pushAgentEvent } from '../ws/agent';

export interface AgentSession {
  id:                string;
  tenant_id:         string;
  session_id:        string;
  intent_id:         string | null;
  channel:           string;
  status:            'pending' | 'active' | 'completed' | 'transferred';
  assigned_agent_id: string | null;
  user_id:           string | null;
  reject_reason:     string | null;
  handoff_context:   Record<string, unknown> | null;   // v3.2: AI 转人工时打包的上下文
  created_at:        string;
  updated_at:        string;
  closed_at:         string | null;
}

export interface AgentMessage {
  id:               string;
  agent_session_id: string;
  role:             'user' | 'agent' | 'system' | 'lios_auto';
  content:          string;
  agent_id:         string | null;
  created_at:       string;
}

// session_id prefix → channel heuristic
function detectChannel(sessionId: string): string {
  const s = sessionId.toLowerCase();
  if (s.startsWith('wx-') || s.startsWith('wechat-'))    return 'wechat';
  if (s.startsWith('line-'))                              return 'line';
  if (s.startsWith('shopee-'))                            return 'shopee';
  if (s.startsWith('wa-')   || s.startsWith('whatsapp-')) return 'whatsapp';
  return 'web';
}

/**
 * Create an agent session as part of LIOS reject/hold escalation.
 * Inserts the session, copies user message + LIOS auto-reply into messages,
 * and broadcasts the event to subscribed agent clients.
 */
export async function createEscalationSession(opts: {
  tenant_id:        string;
  session_id:       string;
  intent_id:        string;
  user_message:     string;
  lios_reply:       string;
  reject_reason:    string;
  user_id?:         string;
  handoff_context?: Record<string, unknown>;   // v3.2：转人工上下文打包
}): Promise<AgentSession> {
  const { tenant_id, session_id, intent_id, user_message, lios_reply, reject_reason, user_id, handoff_context } = opts;

  const existing = await queryOne<AgentSession>(
    `SELECT * FROM lios_agent_sessions WHERE intent_id = $1`,
    [intent_id],
  );
  if (existing) {
    // 即便已存在，如果本次提供了更完整的 handoff_context 且原 session 还没填，做一次回填
    if (handoff_context && !(existing as unknown as { handoff_context?: unknown }).handoff_context) {
      await query(
        `UPDATE lios_agent_sessions SET handoff_context = $2::jsonb WHERE id = $1`,
        [existing.id, JSON.stringify(handoff_context)],
      ).catch(() => {});
    }
    return existing;
  }

  const channel = detectChannel(session_id);

  const session = await queryOne<AgentSession>(
    `INSERT INTO lios_agent_sessions
       (tenant_id, session_id, intent_id, channel, status, user_id, reject_reason, handoff_context)
     VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7::jsonb)
     RETURNING *`,
    [tenant_id, session_id, intent_id, channel, user_id ?? null, reject_reason,
     handoff_context ? JSON.stringify(handoff_context) : null],
  );
  if (!session) throw new Error('failed to create agent session');

  await query(
    `INSERT INTO lios_agent_messages (agent_session_id, role, content)
     VALUES ($1, 'user', $2), ($1, 'lios_auto', $3),
            ($1, 'system', $4)`,
    [session.id, user_message, lios_reply, `已转人工客服 · 原因：${reject_reason}`],
  );

  pushAgentEvent(tenant_id, 'session_created', {
    session,
    preview: user_message.slice(0, 80),
    handoff_context,
  });

  return session;
}

export async function appendMessage(opts: {
  agent_session_id: string;
  role:             'user' | 'agent' | 'system' | 'lios_auto';
  content:          string;
  agent_id?:        string;
}): Promise<AgentMessage> {
  const { agent_session_id, role, content, agent_id } = opts;
  const m = await queryOne<AgentMessage>(
    `INSERT INTO lios_agent_messages (agent_session_id, role, content, agent_id)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [agent_session_id, role, content, agent_id ?? null],
  );
  if (!m) throw new Error('failed to append agent message');

  // Bump session updated_at
  await query(`UPDATE lios_agent_sessions SET updated_at = now() WHERE id = $1`, [agent_session_id]);

  return m;
}

export async function listMessages(agentSessionId: string): Promise<AgentMessage[]> {
  return query<AgentMessage>(
    `SELECT * FROM lios_agent_messages
     WHERE agent_session_id = $1
     ORDER BY created_at ASC`,
    [agentSessionId],
  );
}
