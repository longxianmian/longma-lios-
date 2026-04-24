import { query, queryOne } from '../db/client';
import {
  LiosPlugin,
  LiosPluginInvocation,
  PluginOutputRole,
} from '../types/lios';
import { invokeLlmPlaceholder, PlaceholderInput } from './llmPlaceholder';

// ── CRUD ─────────────────────────────────────────────────────────────────────

export async function registerPlugin(
  data: Omit<LiosPlugin, 'id' | 'created_at' | 'updated_at'>
): Promise<LiosPlugin> {
  const [plugin] = await query<LiosPlugin>(
    `INSERT INTO lios_plugins
       (tenant_id, name, description, plugin_type, endpoint, config, output_role, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (tenant_id, name) DO UPDATE SET
       description = EXCLUDED.description,
       plugin_type = EXCLUDED.plugin_type,
       endpoint    = EXCLUDED.endpoint,
       config      = EXCLUDED.config,
       output_role = EXCLUDED.output_role,
       status      = EXCLUDED.status,
       updated_at  = NOW()
     RETURNING *`,
    [
      data.tenant_id, data.name, data.description, data.plugin_type,
      data.endpoint, JSON.stringify(data.config), data.output_role, data.status ?? 'active',
    ]
  );
  return plugin;
}

export async function listPlugins(
  tenantId: string,
  statusFilter?: string
): Promise<LiosPlugin[]> {
  return statusFilter
    ? query<LiosPlugin>(
        `SELECT * FROM lios_plugins WHERE tenant_id=$1 AND status=$2 ORDER BY created_at DESC`,
        [tenantId, statusFilter]
      )
    : query<LiosPlugin>(
        `SELECT * FROM lios_plugins WHERE tenant_id=$1 ORDER BY created_at DESC`,
        [tenantId]
      );
}

export async function getPlugin(pluginId: string, tenantId: string): Promise<LiosPlugin | null> {
  return queryOne<LiosPlugin>(
    `SELECT * FROM lios_plugins WHERE id=$1 AND tenant_id=$2`,
    [pluginId, tenantId]
  );
}

// ── Invoke ────────────────────────────────────────────────────────────────────

export interface InvokePluginArgs {
  tenantId:  string;
  pluginId:  string;
  intentId?: string;
  input:     PlaceholderInput;
}

export interface InvokePluginResult {
  invocation: LiosPluginInvocation;
  output_role: PluginOutputRole;
  candidate?: { name: string; description: string; score: number };
  evidence?:  { type: string; content: string; trust_level: 'L1'|'L2'|'L3'|'L4'; weight: number };
}

export async function invokePlugin(args: InvokePluginArgs): Promise<InvokePluginResult> {
  const plugin = await getPlugin(args.pluginId, args.tenantId);
  if (!plugin)              throw new Error(`plugin not found: ${args.pluginId}`);
  if (plugin.status !== 'active') throw new Error(`plugin disabled: ${args.pluginId}`);

  const t0 = Date.now();
  let outputData: ReturnType<typeof invokeLlmPlaceholder>;
  let callStatus: 'ok' | 'error' = 'ok';
  let errorMsg: string | null    = null;

  try {
    // P0: always use placeholder; production would HTTP-call plugin.endpoint
    outputData = invokeLlmPlaceholder(args.input, plugin.config, plugin.output_role);
  } catch (err) {
    callStatus = 'error';
    errorMsg   = (err as Error).message;
    outputData = invokeLlmPlaceholder(
      { prompt: '' }, plugin.config, plugin.output_role
    );
  }

  const latencyMs = Date.now() - t0;

  const [inv] = await query<LiosPluginInvocation>(
    `INSERT INTO lios_plugin_invocations
       (tenant_id, plugin_id, intent_id, input, output, output_role, latency_ms, status, error_msg)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING *`,
    [
      args.tenantId, plugin.id, args.intentId ?? null,
      JSON.stringify(args.input), JSON.stringify(outputData.raw),
      plugin.output_role, latencyMs, callStatus, errorMsg,
    ]
  );

  return {
    invocation:  inv,
    output_role: plugin.output_role,
    candidate:   outputData.candidate,
    evidence:    outputData.evidence,
  };
}
