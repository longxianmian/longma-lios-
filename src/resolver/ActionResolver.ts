/**
 * ActionResolver —— 律 2 的工程落地（白皮书 §5.7）
 *
 * 职责：
 *   - 给定 Decision 与 Ledger 摘要，按 idempotency_scope 生成稳定 action_id
 *   - 查账本：is_committed(action_id)? → 已提交则返回 referenceExisting
 *   - 未提交：占位 pending → 返回让调用方继续
 *
 * Action ID 生成规则（白皮书 §5.7）：
 *   action_id = sha256(JSON.stringify({
 *     tenant, scope, type, target, claims  // 标准化后
 *   })).slice(0,16)
 *
 * idempotency_scope 表：
 *   - 转人工            → conversation
 *   - 查询订单          → order_id+channel
 *   - 申请退款          → order_id+refund_reason
 *   - 领取优惠券        → user_id+coupon_id
 *   - 修改用户资料      → user_id+field_name
 *   - 普通咨询答复      → user_input_hash+conversation
 *
 * 严格不做（施工方案 T7）：
 *   - 不把 ActionResolver 逻辑塞进 LI Kernel
 *   - 不在 Resolver 写关键词
 */

import { createHash } from 'node:crypto';
import { query } from '../db/client';
import type { CandidateAction } from '../builder/CandidatePackBuilder';
import type { IdempotencyScope } from '../policy/TenantPolicy';

// ─────────────────────────────────────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────────────────────────────────────

export type ActionLifecycleStatus = 'pending' | 'committed' | 'cancelled';

export interface ActionIdInput {
  readonly tenant_id: string;
  readonly conversation_id: string;
  readonly action_type: string;
  readonly idempotency_scope: IdempotencyScope;
  readonly target_object_id?: string;            // order_id / coupon_id / etc
  readonly normalized_claims: ReadonlyArray<Readonly<Record<string, unknown>>>;
  readonly user_input_hash?: string;             // 普通咨询答复用
  readonly user_id?: string;                     // user_id+coupon_id / user_id+field_name 用
  readonly channel?: string;                     // order_id+channel 用
  readonly refund_reason?: string;
  readonly coupon_id?: string;
  readonly field_name?: string;
}

export interface ResolvedAction {
  readonly action_id: string;
  readonly action_type: string;
  readonly idempotency_scope: IdempotencyScope;
  readonly target_object_id?: string;
  readonly already_committed: boolean;
  readonly existing_status?: ActionLifecycleStatus;
  readonly existing_seq?: number;
}

export interface ResolveContext {
  readonly tenant_id: string;
  readonly conversation_id: string;
  readonly user_input?: string;          // 普通咨询答复 hash 用
  readonly user_id?: string;
  readonly channel?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Action ID 生成（白皮书 §5.7）
// ─────────────────────────────────────────────────────────────────────────────

export function generateActionId(input: ActionIdInput): string {
  // 按 idempotency_scope 决定哪些字段进入 hash
  const fields: Record<string, unknown> = {
    tenant: input.tenant_id,
    scope: input.idempotency_scope,
    type: input.action_type,
  };

  switch (input.idempotency_scope) {
    case 'conversation':
      fields.conversation = input.conversation_id;
      break;

    case 'order_id+channel':
      fields.order_id = input.target_object_id;
      fields.channel  = input.channel ?? 'unknown';
      break;

    case 'order_id+refund_reason':
      fields.order_id      = input.target_object_id;
      fields.refund_reason = input.refund_reason ?? extractRefundReason(input.normalized_claims);
      break;

    case 'user_id+coupon_id':
      fields.user_id   = input.user_id;
      fields.coupon_id = input.coupon_id;
      break;

    case 'user_id+field_name':
      fields.user_id    = input.user_id;
      fields.field_name = input.field_name;
      break;

    case 'user_input_hash+conversation':
      fields.input_hash   = input.user_input_hash ?? '';
      fields.conversation = input.conversation_id;
      break;
  }

  // 主张内容也参与 hash（避免不同 claim 内容共享 ID）
  fields.claims = canonicalize(input.normalized_claims);

  const h = createHash('sha256').update(JSON.stringify(fields)).digest('hex');
  return `act-${h.slice(0, 16)}`;
}

function extractRefundReason(
  claims: ReadonlyArray<Readonly<Record<string, unknown>>>,
): string {
  for (const c of claims) {
    const cnt = c.content as Record<string, unknown> | undefined;
    if (cnt && typeof cnt.refund_reason === 'string') return cnt.refund_reason;
    if (cnt && typeof cnt.reason === 'string') return cnt.reason;
  }
  return 'unspecified';
}

// 规范化：递归排序 key，让相同语义产生相同 hash
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) sorted[k] = canonicalize(o[k]);
    return sorted;
  }
  return value;
}

export function hashUserInput(s: string): string {
  return createHash('sha256').update(s.trim().toLowerCase()).digest('hex').slice(0, 16);
}

// ─────────────────────────────────────────────────────────────────────────────
// ActionResolver
// ─────────────────────────────────────────────────────────────────────────────

export class ActionResolver {
  /**
   * 给定一组候选 action，逐一生成 action_id 并查账本。
   * 返回每个 action 的解析结果（含 already_committed 标志）。
   */
  async resolve(
    candidate_actions: ReadonlyArray<CandidateAction>,
    ctx: ResolveContext,
  ): Promise<ResolvedAction[]> {
    const out: ResolvedAction[] = [];
    for (const ca of candidate_actions) {
      const idInput = buildIdInput(ca, ctx);
      const action_id = generateActionId(idInput);
      const existing = await this.fetchExisting(action_id, ctx);

      out.push(Object.freeze({
        action_id,
        action_type: ca.action_type,
        idempotency_scope: ca.idempotency_scope,
        ...(ca.target_object_id ? { target_object_id: ca.target_object_id } : {}),
        already_committed: existing?.action_status === 'committed',
        ...(existing
          ? { existing_status: existing.action_status, existing_seq: existing.seq }
          : {}),
      }));
    }
    return out;
  }

  /**
   * 占位 pending —— 写一条 ledger 行，标记本次生成的 action 进入 pending 状态。
   * 实际 commit 由调用方在动作执行成功后再写一条 status=committed。
   */
  async stagePending(
    resolved: ResolvedAction,
    ctx: ResolveContext,
  ): Promise<void> {
    if (resolved.already_committed) return;
    await query(
      `INSERT INTO lios_ledgers
        (entity_type, entity_id, event_type, payload, tenant_id,
         conversation_id, action_id, action_status)
       VALUES
        ('action', gen_random_uuid(), 'action.created',
         $1, $2, $3, $4, 'pending')`,
      [
        JSON.stringify({ action_type: resolved.action_type, source: 'action_resolver' }),
        ctx.tenant_id,
        ctx.conversation_id,
        resolved.action_id,
      ],
    );
  }

  async commit(
    resolved: ResolvedAction,
    ctx: ResolveContext,
    extra_payload: Record<string, unknown> = {},
  ): Promise<void> {
    await query(
      `INSERT INTO lios_ledgers
        (entity_type, entity_id, event_type, payload, tenant_id,
         conversation_id, action_id, action_status)
       VALUES
        ('action', gen_random_uuid(), 'action.executed',
         $1, $2, $3, $4, 'committed')`,
      [
        JSON.stringify({ ...extra_payload, action_type: resolved.action_type, source: 'action_resolver' }),
        ctx.tenant_id,
        ctx.conversation_id,
        resolved.action_id,
      ],
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 内部：查 lios_ledgers 看 action_id 是否 committed
  // ───────────────────────────────────────────────────────────────────────────

  private async fetchExisting(
    action_id: string,
    ctx: ResolveContext,
  ): Promise<{ action_status: ActionLifecycleStatus; seq: number } | null> {
    const rows = await query<{ action_status: string; seq: string | number }>(
      `SELECT action_status, seq
       FROM   lios_ledgers
       WHERE  conversation_id = $1
         AND  tenant_id       = $2
         AND  action_id       = $3
       ORDER  BY
         CASE action_status
           WHEN 'committed' THEN 0
           WHEN 'cancelled' THEN 1
           WHEN 'pending'   THEN 2
           ELSE 3
         END,
         seq DESC
       LIMIT 1`,
      [ctx.conversation_id, ctx.tenant_id, action_id],
    ).catch(() => []);

    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      action_status: r.action_status as ActionLifecycleStatus,
      seq: typeof r.seq === 'string' ? Number(r.seq) : r.seq,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 候选 action → ActionIdInput 拼装
// ─────────────────────────────────────────────────────────────────────────────

function buildIdInput(
  ca: CandidateAction,
  ctx: ResolveContext,
): ActionIdInput {
  const base: ActionIdInput = {
    tenant_id: ctx.tenant_id,
    conversation_id: ctx.conversation_id,
    action_type: ca.action_type,
    idempotency_scope: ca.idempotency_scope,
    normalized_claims: ca.normalized_claims,
    ...(ca.target_object_id ? { target_object_id: ca.target_object_id } : {}),
    ...(ctx.channel ? { channel: ctx.channel } : {}),
    ...(ctx.user_id ? { user_id: ctx.user_id } : {}),
    ...(ctx.user_input ? { user_input_hash: hashUserInput(ctx.user_input) } : {}),
  };
  return base;
}

// 单例
export const actionResolver = new ActionResolver();
