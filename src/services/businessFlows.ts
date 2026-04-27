/**
 * 业务流程模板：从 lios_assets (asset_type='business_flow') 加载、缓存。
 * 每个流程定义槽位（slots）和完成时的副作用。
 */

import { query } from '../db/client';

export interface FlowSlot {
  name:  string;
  label: string;
  ask:   string;     // 默认追问话术（LLM 仍可改写）
}

export interface BusinessFlow {
  flow_key:           string;
  label:              string;
  intent_keywords:    string[];
  slots:              FlowSlot[];
  completion_action:  string;            // 'transfer_human' | 'reply_only' | ...
  completion_message: string;            // 模板，{slot_name} 占位
}

interface CacheEntry { flows: BusinessFlow[]; loadedAt: number }
const TTL_MS = 60_000;
const cache = new Map<string, CacheEntry>();

export async function getFlows(tenant_id: string): Promise<BusinessFlow[]> {
  const c = cache.get(tenant_id);
  if (c && Date.now() - c.loadedAt < TTL_MS) return c.flows;

  const rows = await query<{ content: string }>(
    `SELECT content
     FROM lios_assets
     WHERE tenant_id = $1
       AND asset_type = 'business_flow'
       AND is_indexed = TRUE`,
    [tenant_id],
  ).catch(() => []);

  const flows: BusinessFlow[] = [];
  for (const r of rows) {
    try {
      const f = JSON.parse(r.content) as BusinessFlow;
      if (f.flow_key && Array.isArray(f.slots)) flows.push(f);
    } catch { /* skip malformed */ }
  }

  cache.set(tenant_id, { flows, loadedAt: Date.now() });
  return flows;
}

export function findFlow(flows: BusinessFlow[], flow_key: string | null | undefined): BusinessFlow | null {
  if (!flow_key) return null;
  return flows.find(f => f.flow_key === flow_key) ?? null;
}

export function fillTemplate(template: string, slots: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, k) => slots[k] ?? '（未提供）');
}

export function invalidateFlows(tenant_id: string): void {
  cache.delete(tenant_id);
}
