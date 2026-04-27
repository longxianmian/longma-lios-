import { FastifyInstance } from 'fastify';
import { query, queryOne } from '../db/client';
import {
  AgentSession, AgentMessage,
  appendMessage, listMessages,
} from '../services/agentSession';
import { pushAgentEvent } from '../ws/agent';
import {
  analyzeIntent, generateReply, LLMAnalysis,
} from '../services/llm';
import { embedText } from '../services/embedding';
import { LiosAsset } from '../types/lios';
import { releaseEscalation } from '../services/conversationState';

interface SessionWithPreview extends AgentSession {
  last_message_preview: string | null;
  last_message_role:    string | null;
  message_count:        number;
}

export async function agentRoutes(app: FastifyInstance) {

  // ── GET /lios/agent/sessions ─────────────────────────────────────────────
  // List sessions for a tenant. Filter by status. Sorted newest-first.
  app.get<{
    Querystring: {
      tenant_id: string;
      status?:   string;
      limit?:    string;
    };
  }>(
    '/lios/agent/sessions',
    {
      schema: {
        querystring: {
          type: 'object', required: ['tenant_id'],
          properties: {
            tenant_id: { type: 'string', minLength: 1 },
            status:    { type: 'string', enum: ['pending', 'active', 'completed', 'transferred', 'all'] },
            limit:     { type: 'string' },
          },
        },
      },
    },
    async (req, reply) => {
      const { tenant_id, status = 'all', limit = '50' } = req.query;
      const max = Math.min(parseInt(limit, 10) || 50, 200);

      const rows = await query<SessionWithPreview>(
        `SELECT s.*,
                (SELECT m.content FROM lios_agent_messages m
                  WHERE m.agent_session_id = s.id
                  ORDER BY m.created_at DESC LIMIT 1) AS last_message_preview,
                (SELECT m.role FROM lios_agent_messages m
                  WHERE m.agent_session_id = s.id
                  ORDER BY m.created_at DESC LIMIT 1) AS last_message_role,
                (SELECT COUNT(*)::int FROM lios_agent_messages m
                  WHERE m.agent_session_id = s.id) AS message_count
         FROM lios_agent_sessions s
         WHERE s.tenant_id = $1
           AND ($2::text = 'all' OR s.status = $2::text)
         ORDER BY
           CASE s.status WHEN 'pending' THEN 1 WHEN 'active' THEN 2 ELSE 3 END,
           s.created_at DESC
         LIMIT $3`,
        [tenant_id, status, max],
      );

      return reply.code(200).send({ sessions: rows, count: rows.length });
    },
  );

  // ── GET /lios/agent/sessions/:id ─────────────────────────────────────────
  app.get<{ Params: { id: string }; Querystring: { tenant_id: string } }>(
    '/lios/agent/sessions/:id',
    {
      schema: {
        querystring: {
          type: 'object', required: ['tenant_id'],
          properties: { tenant_id: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const { tenant_id } = req.query;

      const session = await queryOne<AgentSession>(
        `SELECT * FROM lios_agent_sessions WHERE id = $1 AND tenant_id = $2`,
        [id, tenant_id],
      );
      if (!session) return reply.code(404).send({ error: 'session not found' });

      const messages = await listMessages(id);
      return reply.code(200).send({ session, messages });
    },
  );

  // ── POST /lios/agent/sessions/:id/reply ──────────────────────────────────
  app.post<{
    Params: { id: string };
    Body:   { tenant_id: string; agent_id: string; content: string };
  }>(
    '/lios/agent/sessions/:id/reply',
    {
      schema: {
        body: {
          type: 'object', required: ['tenant_id', 'agent_id', 'content'],
          properties: {
            tenant_id: { type: 'string', minLength: 1 },
            agent_id:  { type: 'string', minLength: 1 },
            content:   { type: 'string', minLength: 1, maxLength: 4000 },
          },
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const { tenant_id, agent_id, content } = req.body;

      const session = await queryOne<AgentSession>(
        `SELECT * FROM lios_agent_sessions WHERE id = $1 AND tenant_id = $2`,
        [id, tenant_id],
      );
      if (!session) return reply.code(404).send({ error: 'session not found' });

      // Auto-promote pending → active and assign on first reply
      if (session.status === 'pending') {
        await query(
          `UPDATE lios_agent_sessions
             SET status = 'active', assigned_agent_id = $2, updated_at = now()
           WHERE id = $1`,
          [id, agent_id],
        );
      }

      const msg = await appendMessage({
        agent_session_id: id,
        role:             'agent',
        content,
        agent_id,
      });

      pushAgentEvent(tenant_id, 'message_received', {
        session_id: id,
        message:    msg,
      });

      return reply.code(201).send({ message: msg });
    },
  );

  // ── PUT /lios/agent/sessions/:id/status ──────────────────────────────────
  app.put<{
    Params: { id: string };
    Body:   { tenant_id: string; status: 'pending' | 'active' | 'completed' };
  }>(
    '/lios/agent/sessions/:id/status',
    {
      schema: {
        body: {
          type: 'object', required: ['tenant_id', 'status'],
          properties: {
            tenant_id: { type: 'string', minLength: 1 },
            status:    { type: 'string', enum: ['pending', 'active', 'completed'] },
          },
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const { tenant_id, status } = req.body;

      const updated = await queryOne<AgentSession>(
        `UPDATE lios_agent_sessions
           SET status = $3,
               closed_at = CASE WHEN $3 = 'completed' THEN now() ELSE closed_at END,
               updated_at = now()
         WHERE id = $1 AND tenant_id = $2
         RETURNING *`,
        [id, tenant_id, status],
      );
      if (!updated) return reply.code(404).send({ error: 'session not found' });

      // T1.4：人工显式标记完成 → 解除 conversation_states.escalated 守卫
      if (status === 'completed' && updated.session_id) {
        await releaseEscalation(updated.session_id, 'completed');
      }

      pushAgentEvent(tenant_id, 'session_updated', { session: updated });
      return reply.code(200).send({ session: updated });
    },
  );

  // ── POST /lios/agent/sessions/:id/transfer ───────────────────────────────
  // Mark session transferred back to digital agent (no further human action expected)
  app.post<{ Params: { id: string }; Body: { tenant_id: string; reason?: string } }>(
    '/lios/agent/sessions/:id/transfer',
    {
      schema: {
        body: {
          type: 'object', required: ['tenant_id'],
          properties: {
            tenant_id: { type: 'string', minLength: 1 },
            reason:    { type: 'string' },
          },
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const { tenant_id, reason } = req.body;

      const updated = await queryOne<AgentSession>(
        `UPDATE lios_agent_sessions
           SET status = 'transferred', closed_at = now(), updated_at = now()
         WHERE id = $1 AND tenant_id = $2
         RETURNING *`,
        [id, tenant_id],
      );
      if (!updated) return reply.code(404).send({ error: 'session not found' });

      await appendMessage({
        agent_session_id: id,
        role:             'system',
        content:          reason ? `已转回数字客服 · 原因：${reason}` : '已转回数字客服',
      });

      pushAgentEvent(tenant_id, 'session_updated', { session: updated });
      return reply.code(200).send({ session: updated });
    },
  );

  // ── POST /lios/agent/suggest ─────────────────────────────────────────────
  // Returns an AI-generated reply suggestion grounded in the tenant's KB.
  app.post<{
    Body: {
      tenant_id:    string;
      user_message: string;
      session_id?:  string;
    };
  }>(
    '/lios/agent/suggest',
    {
      schema: {
        body: {
          type: 'object', required: ['tenant_id', 'user_message'],
          properties: {
            tenant_id:    { type: 'string', minLength: 1 },
            user_message: { type: 'string', minLength: 1, maxLength: 1000 },
            session_id:   { type: 'string' },
          },
        },
      },
    },
    async (req, reply) => {
      const { tenant_id, user_message } = req.body;

      // Vector search the tenant KB for the best-matching asset
      let kbAssets: { name: string; content: string; score?: number }[] = [];
      try {
        const vec = await embedText(user_message);
        kbAssets = await query<{ name: string; content: string; score: number }>(
          `SELECT name, content,
                  1 - (embedding <=> $1::float4[]) AS score
           FROM lios_assets
           WHERE tenant_id = $2 AND is_indexed = TRUE AND embedding IS NOT NULL
           ORDER BY embedding <=> $1::float4[]
           LIMIT 3`,
          [`{${vec.join(',')}}`, tenant_id],
        );
      } catch {
        // Fall through with empty KB — suggest endpoint must still respond
      }

      const kbContext = kbAssets
        .map(a => `${a.name}\n${a.content.slice(0, 1500)}`)
        .join('\n---\n');

      // Try grounded reply first; if KB is empty, fall back to a brief safe template
      let suggestion: string;
      let confidence = 0.5;
      let analysis: LLMAnalysis | null = null;
      try {
        analysis = await analyzeIntent(user_message, kbContext, { tenant_id });
      } catch { /* analysis is optional */ }

      const tenantRow = await queryOne<{ company_name: string }>(
        `SELECT company_name FROM lios_tenants WHERE tenant_id = $1`, [tenant_id],
      ).catch(() => null);
      const tenantName = tenantRow?.company_name ?? '客服中心';

      try {
        const out = await generateReply({
          message:     user_message,
          tenantId:    tenant_id,
          tenantName,
          retrievedKB: kbContext,
        });
        suggestion = out.reply;
        confidence = kbAssets.length > 0
          ? Math.min(0.95, 0.6 + (kbAssets[0].score ?? 0) * 0.4)
          : (out.fallback_used ? 0.2 : 0.4);
      } catch {
        suggestion = '感謝您的訊息，請稍候，我會盡快為您回覆。';
        confidence = 0.2;
      }

      return reply.code(200).send({
        suggestion,
        confidence: Number(confidence.toFixed(2)),
        sources:    kbAssets.map(a => ({ name: a.name, score: Number((a.score ?? 0).toFixed(3)) })),
        analysis,
      });
    },
  );

  // ── GET /lios/agent/stats ────────────────────────────────────────────────
  app.get<{ Querystring: { tenant_id: string } }>(
    '/lios/agent/stats',
    {
      schema: {
        querystring: {
          type: 'object', required: ['tenant_id'],
          properties: { tenant_id: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (req, reply) => {
      const { tenant_id } = req.query;
      const rows = await query<{ status: string; n: string }>(
        `SELECT status, COUNT(*)::int AS n
         FROM lios_agent_sessions
         WHERE tenant_id = $1
         GROUP BY status`,
        [tenant_id],
      );
      const stats = { pending: 0, active: 0, completed: 0, transferred: 0 };
      for (const { status, n } of rows) {
        if (status in stats) (stats as Record<string, number>)[status] = Number(n);
      }
      return reply.code(200).send({ tenant_id, stats });
    },
  );

  // ── GET /lios/agent/kb/search ────────────────────────────────────────────
  // Convenience proxy used by the AI panel "knowledge search" widget.
  app.get<{ Querystring: { tenant_id: string; q: string } }>(
    '/lios/agent/kb/search',
    {
      schema: {
        querystring: {
          type: 'object', required: ['tenant_id', 'q'],
          properties: {
            tenant_id: { type: 'string', minLength: 1 },
            q:         { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (req, reply) => {
      const { tenant_id, q } = req.query;
      const assets = await query<LiosAsset>(
        `SELECT id, name, content, asset_type, scope
         FROM lios_assets
         WHERE tenant_id = $1
           AND is_indexed = TRUE
           AND (name ILIKE '%' || $2 || '%' OR content ILIKE '%' || $2 || '%')
         ORDER BY created_at DESC
         LIMIT 10`,
        [tenant_id, q],
      );
      return reply.code(200).send({
        results: assets.map(a => ({
          id:      a.id,
          name:    a.name,
          excerpt: a.content.slice(0, 400),
        })),
      });
    },
  );
}

// Re-export types so callers can `import { AgentSession } from './routes/agent'` if convenient
export type { AgentSession, AgentMessage };
