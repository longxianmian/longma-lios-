import { FastifyInstance } from 'fastify';
import { registerPlugin, listPlugins, getPlugin, invokePlugin } from '../plugins/registry';
import { LiosPlugin } from '../types/lios';

export async function pluginRoutes(app: FastifyInstance) {

  // ── POST /lios/plugins/register ───────────────────────────────────────────
  app.post<{ Body: Partial<LiosPlugin> & { tenant_id: string } }>(
    '/lios/plugins/register',
    {
      schema: {
        body: {
          type: 'object',
          required: ['tenant_id', 'name'],
          properties: {
            tenant_id:   { type: 'string', minLength: 1 },
            name:        { type: 'string', minLength: 1, maxLength: 120 },
            description: { type: 'string' },
            plugin_type: { type: 'string', enum: ['llm', 'tool', 'retrieval'] },
            endpoint:    { type: 'string' },
            config:      { type: 'object' },
            output_role: { type: 'string', enum: ['candidate', 'evidence'] },
          },
        },
      },
    },
    async (req, reply) => {
      const {
        tenant_id,
        name,
        description  = '',
        plugin_type  = 'llm',
        endpoint     = '',
        config       = {},
        output_role  = 'evidence',
      } = req.body;

      const plugin = await registerPlugin({
        tenant_id,
        name:        name!,
        description,
        plugin_type: (plugin_type ?? 'llm') as import('../types/lios').PluginType,
        endpoint:    endpoint ?? '',
        config:      config ?? {},
        output_role: (output_role ?? 'evidence') as import('../types/lios').PluginOutputRole,
        status:      'active',
      });

      return reply.code(201).send(plugin);
    }
  );

  // ── GET /lios/plugins ─────────────────────────────────────────────────────
  app.get<{ Querystring: { tenant_id: string; status?: string } }>(
    '/lios/plugins',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['tenant_id'],
          properties: {
            tenant_id: { type: 'string', minLength: 1 },
            status:    { type: 'string', enum: ['active', 'disabled'] },
          },
        },
      },
    },
    async (req, reply) => {
      const { tenant_id, status } = req.query;
      const plugins = await listPlugins(tenant_id, status);
      return reply.code(200).send({ tenant_id, count: plugins.length, plugins });
    }
  );

  // ── POST /lios/plugins/:plugin_id/invoke ──────────────────────────────────
  // Plugin output is routed to 'candidate' or 'evidence' ONLY — never to decision.
  app.post<{
    Params: { plugin_id: string };
    Body: {
      tenant_id:  string;
      intent_id?: string;
      input: {
        prompt:         string;
        context?:       Record<string, unknown>;
        system_prompt?: string;
      };
    };
  }>(
    '/lios/plugins/:plugin_id/invoke',
    {
      schema: {
        params: {
          type: 'object',
          properties: { plugin_id: { type: 'string' } },
        },
        body: {
          type: 'object',
          required: ['tenant_id', 'input'],
          properties: {
            tenant_id: { type: 'string', minLength: 1 },
            intent_id: { type: 'string' },
            input: {
              type: 'object',
              required: ['prompt'],
              properties: {
                prompt:        { type: 'string', minLength: 1, maxLength: 8000 },
                context:       { type: 'object' },
                system_prompt: { type: 'string' },
              },
            },
          },
        },
      },
    },
    async (req, reply) => {
      const { plugin_id }           = req.params;
      const { tenant_id, intent_id, input } = req.body;

      const plugin = await getPlugin(plugin_id, tenant_id);
      if (!plugin) return reply.code(404).send({ error: 'plugin not found' });
      if (plugin.status !== 'active') {
        return reply.code(409).send({ error: 'plugin is disabled' });
      }

      const result = await invokePlugin({
        tenantId:  tenant_id,
        pluginId:  plugin_id,
        intentId:  intent_id,
        input,
      });

      // Enforce: output_role is ONLY 'candidate' or 'evidence'
      const channelOutput = result.output_role === 'candidate'
        ? result.candidate
        : result.evidence;

      return reply.code(200).send({
        invocation_id: result.invocation.id,
        plugin_id,
        plugin_name:   plugin.name,
        tenant_id,
        output_role:   result.output_role,   // 'candidate' | 'evidence' — never 'decision'
        output:        channelOutput,
        latency_ms:    result.invocation.latency_ms,
        status:        result.invocation.status,
        processed_at:  result.invocation.created_at,
      });
    }
  );
}
