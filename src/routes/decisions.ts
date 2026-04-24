import { FastifyInstance } from 'fastify';
import { query, queryOne } from '../db/client';

export async function decisionRoutes(app: FastifyInstance) {

  // ── GET /lios/dashboard/stats?tenant_id=xxx ──────────────────────────────
  app.get<{
    Querystring: { tenant_id: string };
  }>('/lios/dashboard/stats', {
    schema: {
      querystring: {
        type: 'object',
        required: ['tenant_id'],
        properties: {
          tenant_id: { type: 'string', minLength: 1 },
        },
      },
    },
  }, async (req, reply) => {
    const { tenant_id } = req.query;

    const [statsRow, assetsRow, pluginsRow, recentRows] = await Promise.all([
      queryOne<{ total: string; accept_cnt: string }>(
        `SELECT COUNT(*)::text AS total,
                COUNT(*) FILTER (WHERE decision_type='accept')::text AS accept_cnt
         FROM lios_decisions WHERE tenant_id=$1`,
        [tenant_id]
      ),
      queryOne<{ cnt: string }>(
        `SELECT COUNT(*)::text AS cnt FROM lios_assets WHERE tenant_id=$1`,
        [tenant_id]
      ),
      queryOne<{ cnt: string }>(
        `SELECT COUNT(*)::text AS cnt FROM lios_plugins WHERE tenant_id=$1`,
        [tenant_id]
      ),
      query(
        `SELECT d.id, d.decision_type, d.confidence, d.rationale, d.created_at,
                i.trace_id, i.raw_input, i.session_id, i.status AS intent_status
         FROM lios_decisions d
         JOIN lios_intents i ON i.id = d.intent_id
         WHERE d.tenant_id=$1
         ORDER BY d.created_at DESC LIMIT 5`,
        [tenant_id]
      ),
    ]);

    const total = parseInt(statsRow?.total ?? '0', 10);
    const acceptCnt = parseInt(statsRow?.accept_cnt ?? '0', 10);
    const assets = parseInt(assetsRow?.cnt ?? '0', 10);
    const plugins = parseInt(pluginsRow?.cnt ?? '0', 10);

    return reply.code(200).send({
      tenant_id,
      total_decisions: total,
      accept_rate: total > 0 ? Math.round((acceptCnt / total) * 100) : 0,
      total_assets: assets,
      total_plugins: plugins,
      recent_decisions: recentRows,
    });
  });

  // ── GET /lios/decisions?tenant_id=xxx ────────────────────────────────────
  app.get<{
    Querystring: { tenant_id: string; page?: string; limit?: string };
  }>('/lios/decisions', {
    schema: {
      querystring: {
        type: 'object',
        required: ['tenant_id'],
        properties: {
          tenant_id: { type: 'string', minLength: 1 },
          page:      { type: 'string' },
          limit:     { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    const { tenant_id } = req.query;
    const page   = Math.max(1, parseInt(req.query.page  ?? '1',  10));
    const limit  = Math.min(100, parseInt(req.query.limit ?? '20', 10));
    const offset = (page - 1) * limit;

    const decisions = await query(
      `SELECT
         d.id,
         d.decision_type,
         d.rationale,
         d.confidence,
         d.hold_count,
         d.metadata,
         d.created_at,
         i.trace_id,
         i.raw_input,
         i.session_id,
         i.status  AS intent_status,
         i.parsed_goal
       FROM lios_decisions  d
       JOIN lios_intents    i ON i.id = d.intent_id
       WHERE d.tenant_id = $1
       ORDER BY d.created_at DESC
       LIMIT $2 OFFSET $3`,
      [tenant_id, limit, offset]
    );

    const countRow = await queryOne<{ cnt: string }>(
      'SELECT COUNT(*)::text AS cnt FROM lios_decisions WHERE tenant_id=$1',
      [tenant_id]
    );

    // Acceptance rate stats
    const statsRow = await queryOne<{ accept_cnt: string; total: string }>(
      `SELECT
         COUNT(*) FILTER (WHERE decision_type='accept')::text AS accept_cnt,
         COUNT(*)::text                                        AS total
       FROM lios_decisions WHERE tenant_id=$1`,
      [tenant_id]
    );

    const total     = parseInt(countRow?.cnt ?? '0', 10);
    const acceptCnt = parseInt(statsRow?.accept_cnt ?? '0', 10);
    const totalStat = parseInt(statsRow?.total ?? '0', 10);

    return reply.code(200).send({
      total,
      page,
      limit,
      accept_rate: totalStat > 0 ? Math.round((acceptCnt / totalStat) * 100) : 0,
      decisions,
    });
  });
}
