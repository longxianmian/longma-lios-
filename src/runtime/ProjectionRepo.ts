/**
 * ProjectionRepo —— 投影加载器（白皮书 §6.2 / §6.3）
 *
 * 职责：
 *   - loadOrRebuild(conversation_id, tenant_id)：拉账本 + 重建投影 + 进 LRU
 *   - invalidate(conversation_id)：清掉缓存（账本写入新事件后调用）
 *   - 不暴露写接口；不允许外部 setter
 *
 * 不做（v2.1 严格不做的事）：
 *   - 不允许投影独立写库（投影只能由 lios_ledgers 折叠出）
 *   - 不允许在 Repo 层做业务规则判定（属于 Kernel/Runtime）
 */

import { query } from '../db/client';
import {
  ConversationProjection,
  LedgerRow,
  LedgerSummary,
  ActionLifecycleStatus,
} from './ConversationProjection';

// ─────────────────────────────────────────────────────────────────────────────
// LRU（极简实现：Map 顺序即访问顺序）
// ─────────────────────────────────────────────────────────────────────────────

class LRU<K, V> {
  private readonly cap: number;
  private readonly map: Map<K, V>;

  constructor(cap = 256) {
    this.cap = cap;
    this.map = new Map();
  }

  get(k: K): V | undefined {
    const v = this.map.get(k);
    if (v === undefined) return undefined;
    this.map.delete(k);
    this.map.set(k, v);
    return v;
  }

  set(k: K, v: V): void {
    if (this.map.has(k)) this.map.delete(k);
    this.map.set(k, v);
    if (this.map.size > this.cap) {
      const oldest = this.map.keys().next().value as K;
      this.map.delete(oldest);
    }
  }

  delete(k: K): void {
    this.map.delete(k);
  }

  clear(): void {
    this.map.clear();
  }

  size(): number {
    return this.map.size;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Repo
// ─────────────────────────────────────────────────────────────────────────────

interface RawLedgerRow {
  seq: string | number;
  event_type: string;
  conversation_id: string | null;
  tenant_id: string;
  entity_type: string;
  entity_id: string;
  created_at: string;
  payload: unknown;
  claims: unknown;
  evidence_pack: unknown;
  bounds: unknown;
  action_id: string | null;
  action_status: string | null;
}

export class ProjectionRepo {
  private readonly cache = new LRU<string, ConversationProjection>(512);

  /**
   * 加载或重建投影。conversation_id 即 session_id（v2.1 之前用 session_id 命名，
   * 投影对外统一为 conversation_id）。
   */
  async loadOrRebuild(
    conversation_id: string,
    tenant_id: string,
  ): Promise<ConversationProjection> {
    const k = cacheKey(conversation_id, tenant_id);
    const cached = this.cache.get(k);
    if (cached) return cached;

    const summary = await this.fetchSummary(conversation_id, tenant_id);
    const proj = ConversationProjection.rebuild(summary);
    this.cache.set(k, proj);
    return proj;
  }

  /**
   * 无缓存重建（用于诊断或测试"销毁后重建一致性"）。
   */
  async forceRebuild(
    conversation_id: string,
    tenant_id: string,
  ): Promise<ConversationProjection> {
    this.cache.delete(cacheKey(conversation_id, tenant_id));
    return this.loadOrRebuild(conversation_id, tenant_id);
  }

  /**
   * 从内存中销毁投影（让下次访问触发重建）。
   * 注意：销毁不影响账本；账本是真相源。
   */
  invalidate(conversation_id: string, tenant_id: string): void {
    this.cache.delete(cacheKey(conversation_id, tenant_id));
  }

  invalidateAll(): void {
    this.cache.clear();
  }

  cacheSize(): number {
    return this.cache.size();
  }

  /**
   * 暴露给 ConversationRuntime（T10）：在 ledger 提交新行后增量推进投影。
   * 注意：这条路径只接受"账本已写入"的行，不允许凭空构造。
   */
  apply(
    conversation_id: string,
    tenant_id: string,
    appended: LedgerRow,
  ): ConversationProjection {
    const k = cacheKey(conversation_id, tenant_id);
    const current = this.cache.get(k) ?? ConversationProjection.empty(conversation_id, tenant_id);
    const next = current.appendEntry(appended);
    this.cache.set(k, next);
    return next;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 内部：从 lios_ledgers 拉行
  // ───────────────────────────────────────────────────────────────────────────

  private async fetchSummary(
    conversation_id: string,
    tenant_id: string,
  ): Promise<LedgerSummary> {
    const rows = await query<RawLedgerRow>(
      `SELECT seq, event_type, conversation_id, tenant_id, entity_type, entity_id,
              created_at, payload, claims, evidence_pack, bounds, action_id, action_status
       FROM   lios_ledgers
       WHERE  conversation_id = $1 AND tenant_id = $2
       ORDER  BY seq ASC`,
      [conversation_id, tenant_id],
    );
    return {
      conversation_id,
      tenant_id,
      rows: rows.map(toLedgerRow),
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────

function cacheKey(conv: string, tenant: string): string {
  return `${tenant}::${conv}`;
}

function toLedgerRow(raw: RawLedgerRow): LedgerRow {
  return {
    seq:             typeof raw.seq === 'string' ? Number(raw.seq) : raw.seq,
    event_type:      raw.event_type,
    conversation_id: raw.conversation_id ?? '',
    tenant_id:       raw.tenant_id,
    entity_type:     raw.entity_type,
    entity_id:       raw.entity_id,
    created_at:      raw.created_at,
    payload:         (raw.payload as Record<string, unknown>) ?? {},
    claims:          (raw.claims as ReadonlyArray<Record<string, unknown>>) ?? null,
    evidence_pack:   (raw.evidence_pack as Record<string, unknown>) ?? null,
    bounds:          (raw.bounds as Record<string, unknown>) ?? null,
    action_id:       raw.action_id,
    action_status:   raw.action_status as ActionLifecycleStatus | null,
  };
}

// 单例（业务侧 import 即用；Runtime 重写时若需独立实例可自行 new）
export const projectionRepo = new ProjectionRepo();
