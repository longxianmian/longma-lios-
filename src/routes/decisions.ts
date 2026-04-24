import { FastifyInstance } from 'fastify';
import { query, queryOne } from '../db/client';

// Shared WHERE clause args and SQL fragment (reused for data + count queries)
const SEARCH_WHERE = `
  ($1::text IS NULL OR d.tenant_id = $1)
  AND ($2::text IS NULL OR t.company_name ILIKE '%' || $2 || '%')
  AND ($3::text IS NULL OR d.created_at::date >= $3::date)
  AND ($4::text IS NULL OR d.created_at::date <= $4::date)
  AND ($5::text IS NULL OR d.decision_type = $5)
  AND ($6::text IS NULL OR i.raw_input ILIKE '%' || $6 || '%')
`;

export async function decisionRoutes(app: FastifyInstance) {

  // ── GET /lios/decisions/search ────────────────────────────────────────────
  app.get<{
    Querystring: {
      tenant_id?:   string;
      tenant_name?: string;
      start_date?:  string;
      end_date?:    string;
      result?:      string;
      keyword?:     string;
      page?:        string;
      limit?:       string;
    };
  }>('/lios/decisions/search', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          tenant_id:   { type: 'string' },
          tenant_name: { type: 'string' },
          start_date:  { type: 'string' },
          end_date:    { type: 'string' },
          result:      { type: 'string', enum: ['accept', 'hold', 'reject'] },
          keyword:     { type: 'string' },
          page:        { type: 'string' },
          limit:       { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    const { tenant_id, tenant_name, start_date, end_date, result, keyword } = req.query;
    const page   = Math.max(1, parseInt(req.query.page  ?? '1',  10));
    const limit  = Math.min(100, parseInt(req.query.limit ?? '20', 10));
    const offset = (page - 1) * limit;

    const args = [
      tenant_id   ?? null,
      tenant_name ?? null,
      start_date  ?? null,
      end_date    ?? null,
      result      ?? null,
      keyword     ?? null,
    ];

    const [decisions, countRow] = await Promise.all([
      query(
        `SELECT
           d.id,
           d.decision_type,
           d.rationale,
           d.confidence,
           d.hold_count,
           d.created_at,
           d.tenant_id,
           i.trace_id,
           i.raw_input,
           i.parsed_goal,
           t.company_name,
           COALESCE((
             SELECT COUNT(*)::int
             FROM lios_candidate_packs cp
             JOIN lios_evidence_pack_index epi ON epi.pack_id = cp.id
             JOIN lios_evidence_items      ev  ON ev.id = epi.evidence_id
             WHERE cp.intent_id = d.intent_id AND ev.trust_level = 'L3'
           ), 0) AS kb_hits,
           COALESCE((
             SELECT STRING_AGG(DISTINCT a.name, ', ')
             FROM lios_candidate_packs cp
             JOIN lios_evidence_pack_index epi ON epi.pack_id = cp.id
             JOIN lios_evidence_items      ev  ON ev.id = epi.evidence_id
             JOIN lios_assets a ON (
               -- full UUID (new format: kb:<type>:<36-char-uuid>)
               (LENGTH(SPLIT_PART(ev.source, ':', 3)) = 36
                AND a.id::text = SPLIT_PART(ev.source, ':', 3))
               OR
               -- 8-char prefix (legacy format: kb:<type>:<8-char-prefix>)
               (LENGTH(SPLIT_PART(ev.source, ':', 3)) < 36
                AND a.id::text LIKE SPLIT_PART(ev.source, ':', 3) || '%')
             )
             WHERE cp.intent_id = d.intent_id
               AND ev.trust_level = 'L3'
               AND ev.source LIKE 'kb:%'
           ), '') AS kb_asset_names,
           (
             SELECT la.payload->>'reply'
             FROM lios_actions la
             WHERE la.decision_id = d.id AND la.action_type = 'chat.reply'
             LIMIT 1
           ) AS reply_text
         FROM lios_decisions d
         JOIN lios_intents  i ON i.id = d.intent_id
         LEFT JOIN lios_tenants t ON t.tenant_id = d.tenant_id
         WHERE ${SEARCH_WHERE}
         ORDER BY d.created_at DESC
         LIMIT $7 OFFSET $8`,
        [...args, limit, offset]
      ),
      queryOne<{ cnt: string }>(
        `SELECT COUNT(*)::text AS cnt
         FROM lios_decisions d
         JOIN lios_intents  i ON i.id = d.intent_id
         LEFT JOIN lios_tenants t ON t.tenant_id = d.tenant_id
         WHERE ${SEARCH_WHERE}`,
        args
      ),
    ]);

    return reply.code(200).send({
      total: parseInt(countRow?.cnt ?? '0', 10),
      page,
      limit,
      decisions,
    });
  });

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
