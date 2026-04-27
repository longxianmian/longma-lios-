/**
 * LIOS v2.2 治理服务对外契约（DecideRequest / DecideResult）。
 *
 * 锁定后不可随意改 —— 这是 LIOS 对外（天问 / 标典 / 资产化 / 问问 / ...）的核心 API 契约。
 *
 * 严格遵循《LIOSGovernanceService 与 ConversationRuntime 拆分边界书 v0.1》§3：
 *   - LIOSGovernanceService 是无状态决策计算
 *   - 律 2 family-track 累计的"读"侧 = req.projection_snapshot
 *   - 律 2 family-track 累计的"写"侧 = ConversationRuntime.projection.applyTurn
 *   - result.ledger_payload 必须含 ConversationRuntime 写完整 9 列 + 桥接行所需的全部字段
 */

import type { ClaimType } from '../extractor/ClaimExtractor';

// 标识：让 ClaimType 不被未引用警告误删（以及给将来 strict ClaimType 校验留接口）
export type _DependsOnClaimType = ClaimType;

// ─────────────────────────────────────────────────────────────────────────────
// 请求
// ─────────────────────────────────────────────────────────────────────────────

export interface DecideRequest {
  // 应用层信息
  readonly tenant_id: string;
  readonly source_app: string;            // "tianwen" | "biaodian" | "wenwen" | "demo" | ...
  readonly session_id: string;
  readonly user_message: string;
  readonly language?: 'zh' | 'th' | 'en' | 'auto';
  readonly context?: Readonly<Record<string, unknown>>;
  readonly external_evidence?: ReadonlyArray<ExternalEvidence>;
  readonly app_trace_id?: string;

  /**
   * ⚠️ 关键字段（拆分边界书 §1.2 / §4）：
   * 律 2 family-track 累计的"读"侧——通过参数把累计状态传进来，
   * 让 LIOSGovernanceService 保持无状态计算。
   */
  readonly projection_snapshot?: ProjectionSnapshot;

  /** 应用方提供的 ledger 序号（可选；用于幂等关联）*/
  readonly ledger_seq?: number;
}

export interface ExternalEvidence {
  readonly source: string;                // "google_maps" | "asset_system" | "external_api"
  readonly type: string;                  // "places_search" | "supply_pack" | ...
  readonly data: Readonly<Record<string, unknown>>;
  readonly confidence?: number;
  readonly anchor?: string;
}

/**
 * v2.1 ConversationProjection 的 readonly 镜像。
 * 包含律 2 family-track 累计需要的全部状态。
 *
 * 边界书 §4.2 的不变量证明前提：
 *   projection_state_after_turn_(k-1) ≡ projection_snapshot_after_turn_(k-1)
 */
export interface ProjectionSnapshot {
  readonly family_track: Readonly<Record<string, FamilyTrackEntry>>;
  readonly recent_turns: ReadonlyArray<RecentTurn>;
  // 兼容 v2.1 ConversationProjection 其它字段（pending_slots / committed_actions / attempts / ...）
  // 由 ConversationRuntime 在 snapshot() 时填齐
  readonly [key: string]: unknown;
}

export interface FamilyTrackEntry {
  readonly accept_count: number;
  readonly hold_count: number;
  readonly reject_count: number;
  readonly last_verdict: 'accept' | 'hold' | 'reject';
}

export interface RecentTurn {
  readonly seq: number;
  readonly verdict: string;
  readonly family: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 返回
// ─────────────────────────────────────────────────────────────────────────────

export interface DecideResult {
  // 决策结果
  readonly verdict: 'accept' | 'hold' | 'reject';
  readonly reason: string;
  readonly bounds: BoundsView;
  readonly reply_draft: string;
  readonly structured_response?: StructuredResponse;

  /**
   * ⚠️ 关键字段（边界书 §6）：
   * ConversationRuntime 写完整 9 列 ledger + 桥接行 + actions 所需的全部材料。
   * LIOSGovernanceService 自身不写 ledger；信息通过本字段外露。
   */
  readonly ledger_payload: LedgerPayload;

  // 追溯
  readonly trace_id: string;
  readonly ledger_seq_committed?: number;
}

export interface BoundsView {
  readonly must: ReadonlyArray<string>;
  readonly must_not: ReadonlyArray<string>;
  readonly may: ReadonlyArray<string>;
}

export interface StructuredResponse {
  readonly type: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface LedgerPayload {
  readonly dominant_family: string;
  readonly verifier_summary: VerifierSummary;
  readonly turn_family: string;
  readonly structured: Readonly<Record<string, unknown>>;

  /** 兼容旧 runner 的桥接行（payload.source = 'unified_llm_v3_pre_kernel'）*/
  readonly pre_kernel_bridge: Readonly<Record<string, unknown>>;

  /** ActionResolver 算出的 actions —— LIOSGovernanceService 不写 ledger，
   *  ConversationRuntime 拿到后逐条写入。*/
  readonly actions_to_stage: ReadonlyArray<ActionToStage>;
}

export interface VerifierSummary {
  readonly structural: Readonly<Record<string, unknown>>;
  readonly semantic: Readonly<Record<string, unknown>>;
  readonly fallback: Readonly<Record<string, unknown>>;
}

export interface ActionToStage {
  readonly action_type: string;
  readonly idempotency_scope: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly ledger_event_type: 'action.created' | 'action.pending';
}
