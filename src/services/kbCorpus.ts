/**
 * 租户 KB 快照：
 * - productNames：可在售商品/服务名（白名单）
 * - kbSummary：注入 prompt 的"边界"片段（极简）
 * - kbCorpus：拼接全文，供 factCheck 比对
 *
 * 60 秒缓存，避免每次回复都打一次 DB。
 */

import { query } from '../db/client';

export interface KBSnapshot {
  tenant_id:    string;
  productNames: string[];
  kbSummary:    string;
  kbCorpus:     string;
}

interface CacheEntry { snap: KBSnapshot; loadedAt: number }
const TTL_MS = 60_000;
const cache = new Map<string, CacheEntry>();

function extractBracketed(content: string): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(/【([^】]{1,40})】/g)) out.push(m[1].trim());
  return out;
}

export async function getKBSnapshot(tenant_id: string): Promise<KBSnapshot> {
  const c = cache.get(tenant_id);
  if (c && Date.now() - c.loadedAt < TTL_MS) return c.snap;

  const rows = await query<{ name: string; content: string }>(
    `SELECT name, content
     FROM lios_assets
     WHERE tenant_id = $1
       AND is_indexed = TRUE
       AND content NOT LIKE '[待轉錄：%'
       AND content NOT LIKE '[待转录：%'
     ORDER BY created_at DESC
     LIMIT 100`,
    [tenant_id],
  ).catch(() => []);

  const titleSet = new Set<string>();
  rows.forEach(r => {
    if (r.name) titleSet.add(r.name.trim());
    extractBracketed(r.content).forEach(b => titleSet.add(b));
  });
  const productNames = [...titleSet].filter(n => n.length > 0 && n.length < 60);

  const kbSummary = productNames.length === 0
    ? '（本租戶尚未配置任何在售項目；如用戶問及任何具體商品/服務，請說明目前無法提供。）'
    : productNames.map(n => `- ${n}`).join('\n');

  const kbCorpus = rows.map(r => `${r.name}\n${r.content}`).join('\n---\n');

  const snap: KBSnapshot = { tenant_id, productNames, kbSummary, kbCorpus };
  cache.set(tenant_id, { snap, loadedAt: Date.now() });
  return snap;
}

export function invalidateKBSnapshot(tenant_id: string): void {
  cache.delete(tenant_id);
}
