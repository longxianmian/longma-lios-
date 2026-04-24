import { FastifyInstance } from 'fastify';
import { query, queryOne } from '../db/client';
import { LiosAsset, AssetType, AssetScope } from '../types/lios';

// Scope → candidate score heuristic (more specific scope = higher relevance)
const SCOPE_SCORE: Record<AssetScope, number> = {
  task:       0.86,
  project:    0.82,
  enterprise: 0.78,
  role:       0.75,
  industry:   0.70,
};

export async function assetRoutes(app: FastifyInstance) {

  // ── POST /lios/assets/ingest ───────────────────────────────────────────────
  app.post<{
    Body: {
      tenant_id:   string;
      name:        string;
      content:     string;
      asset_type?: AssetType;
      scope:       AssetScope;
      scope_ref?:  string;
      tags?:       string[];
      metadata?:   Record<string, unknown>;
    };
  }>(
    '/lios/assets/ingest',
    {
      schema: {
        body: {
          type: 'object',
          required: ['tenant_id', 'name', 'content', 'scope'],
          properties: {
            tenant_id:  { type: 'string', minLength: 1 },
            name:       { type: 'string', minLength: 1, maxLength: 256 },
            content:    { type: 'string', minLength: 1, maxLength: 100000 },
            asset_type: { type: 'string', enum: ['document','policy','knowledge','template','data'] },
            scope:      { type: 'string', enum: ['industry','enterprise','project','task','role'] },
            scope_ref:  { type: 'string' },
            tags:       { type: 'array', items: { type: 'string' } },
            metadata:   { type: 'object' },
          },
        },
      },
    },
    async (req, reply) => {
      const {
        tenant_id,
        name,
        content,
        asset_type = 'document',
        scope,
        scope_ref  = '',
        tags       = [],
        metadata   = {},
      } = req.body;

      const [asset] = await query<LiosAsset>(
        `INSERT INTO lios_assets
           (tenant_id, name, content, asset_type, scope, scope_ref, tags, metadata, is_indexed)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, FALSE)
         RETURNING *`,
        [tenant_id, name, content, asset_type, scope, scope_ref,
         `{${tags.map(t => `"${t.replace(/"/g, '\\"')}"`).join(',')}}`,
         JSON.stringify(metadata)]
      );

      return reply.code(201).send({
        asset,
        candidate_score: SCOPE_SCORE[scope],
        note: 'Asset ingested. Call POST /lios/assets/reindex to make it available to Candidate Space.',
      });
    }
  );

  // ── GET /lios/assets/search ────────────────────────────────────────────────
  // Must be registered BEFORE /:asset_id to take routing priority
  app.get<{
    Querystring: {
      tenant_id:   string;
      q?:          string;
      scope?:      string;
      asset_type?: string;
      indexed?:    string;
      limit?:      string;
    };
  }>(
    '/lios/assets/search',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['tenant_id'],
          properties: {
            tenant_id:  { type: 'string', minLength: 1 },
            q:          { type: 'string' },
            scope:      { type: 'string', enum: ['industry','enterprise','project','task','role'] },
            asset_type: { type: 'string', enum: ['document','policy','knowledge','template','data'] },
            indexed:    { type: 'string', enum: ['true','false'] },
            limit:      { type: 'string' },
          },
        },
      },
    },
    async (req, reply) => {
      const { tenant_id, q, scope, asset_type, indexed, limit } = req.query;
      const maxRows = Math.min(parseInt(limit ?? '20', 10), 100);

      // Build parameterized query — no dynamic SQL concatenation
      const assets = await query<LiosAsset>(
        `SELECT * FROM lios_assets
         WHERE tenant_id = $1
           AND ($2::text IS NULL OR (
                 name    ILIKE '%' || $2 || '%'
              OR content ILIKE '%' || $2 || '%'
           ))
           AND ($3::text IS NULL OR scope      = $3)
           AND ($4::text IS NULL OR asset_type = $4)
           AND ($5::boolean IS NULL OR is_indexed = $5)
         ORDER BY
           CASE scope WHEN 'task' THEN 1 WHEN 'project' THEN 2 WHEN 'enterprise' THEN 3
                      WHEN 'role' THEN 4 WHEN 'industry' THEN 5 ELSE 6 END,
           created_at DESC
         LIMIT $6`,
        [
          tenant_id,
          q          ?? null,
          scope      ?? null,
          asset_type ?? null,
          indexed !== undefined ? indexed === 'true' : null,
          maxRows,
        ]
      );

      return reply.code(200).send({
        tenant_id,
        count:  assets.length,
        query:  { q, scope, asset_type, indexed },
        assets,
      });
    }
  );

  // ── GET /lios/assets/:asset_id ─────────────────────────────────────────────
  app.get<{
    Params:      { asset_id: string };
    Querystring: { tenant_id: string };
  }>(
    '/lios/assets/:asset_id',
    {
      schema: {
        params:      { type: 'object', properties: { asset_id: { type: 'string' } } },
        querystring: {
          type: 'object', required: ['tenant_id'],
          properties: { tenant_id: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (req, reply) => {
      const { asset_id }  = req.params;
      const { tenant_id } = req.query;

      const asset = await queryOne<LiosAsset>(
        `SELECT * FROM lios_assets WHERE id=$1 AND tenant_id=$2`,
        [asset_id, tenant_id]
      );

      if (!asset) return reply.code(404).send({ error: 'asset not found' });

      return reply.code(200).send({
        asset,
        candidate_score: SCOPE_SCORE[asset.scope as AssetScope],
      });
    }
  );

  // ── POST /lios/assets/reindex ─────────────────────────────────────────────
  // Marks all pending assets as indexed so they become available to Candidate Space.
  app.post<{ Body: { tenant_id: string; asset_ids?: string[] } }>(
    '/lios/assets/reindex',
    {
      schema: {
        body: {
          type: 'object',
          required: ['tenant_id'],
          properties: {
            tenant_id: { type: 'string', minLength: 1 },
            asset_ids: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
    async (req, reply) => {
      const { tenant_id, asset_ids } = req.body;

      let updated: LiosAsset[];
      if (asset_ids && asset_ids.length > 0) {
        // Selective reindex — also enforces tenant isolation
        updated = await query<LiosAsset>(
          `UPDATE lios_assets
           SET is_indexed = TRUE, updated_at = NOW()
           WHERE tenant_id = $1
             AND id = ANY($2::uuid[])
             AND is_indexed = FALSE
           RETURNING *`,
          [tenant_id, asset_ids]
        );
      } else {
        // Full reindex for tenant
        updated = await query<LiosAsset>(
          `UPDATE lios_assets
           SET is_indexed = TRUE, updated_at = NOW()
           WHERE tenant_id = $1 AND is_indexed = FALSE
           RETURNING *`,
          [tenant_id]
        );
      }

      return reply.code(200).send({
        tenant_id,
        reindexed:    updated.length,
        asset_ids:    updated.map(a => a.id),
        available_in: 'Candidate Space (POST /lios/run)',
      });
    }
  );
}
