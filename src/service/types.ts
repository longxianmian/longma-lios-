/**
 * LIOS v2.2 治理服务对外契约（DecideRequest / DecideResult）。
 *
 * 锁定后不可随意改 —— 这是 LIOS 对外（天问 / 标典 / 资产化 / 问问 / ...）的核心 API 契约。
 *
 * 严格遵循《LIOSGovernanceService 与 ConversationRuntime 拆分边界书 v0.1》§3。
 *
 * ⚠️ 字段命名修正（α-3 实施时发现）：
 *   边界书 §3.2 草稿把 LedgerPayload.verifier_summary 设为 { structural, semantic, fallback } 三层
 *   audit summary 对象——这与 v2.1 ledger 实际写入的 verifier_summary（订单核验文本字符串）
 *   语义混淆。本实现按 "v2.1 兼容硬约束" 为准：
 *     - audit_layer / audit_retried 单独承载 BoundsAuditor 三层信息
 *     - order_verifier_* 三个字段单独承载订单核验信息
 */

import type { ClaimType, Claim } from '../extractor/ClaimExtractor';

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

  /**
   * 应用层已抽好的 claims（α-3 引入）。
   *
   * 应用层（ConversationRuntime / 任何 ToB chat）若需要在 decide 前根据 claims
   * 做预处理（如根据 order.query 调 verifier 把结果包装成 external_evidence），
   * 必须先抽 claims。为避免 service 内部重复抽（LLM 调用昂贵），通过本字段传入。
   *
   * 若不传，service 内部自抽。
   */
  readonly pre_extracted_claims?: ReadonlyArray<Claim>;

  /** 应用方提供的 ledger 序号（可选；用于幂等关联）*/
  readonly ledger_seq?: number;

  /** 应用方提供的 trace_id（可选；用于跨系统追溯）*/
  readonly trace_id?: string;

  /** channel 信息（用于 idempotency_scope = order_id+channel）*/
  readonly channel?: string;
}

export interface ExternalEvidence {
  readonly source: string;                // "mock_order_verifier" | "google_maps" | "asset_system" | ...
  readonly type: string;                  // "order_verification" | "places_search" | "supply_pack" | ...
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
  readonly conversation_id: string;
  readonly tenant_id: string;
  readonly inferred_phase: string;
  readonly pending_slots: ReadonlyArray<unknown>;
  readonly filled_slots: ReadonlyArray<unknown>;
  readonly pending_actions: ReadonlyArray<unknown>;
  readonly committed_actions: ReadonlyArray<unknown>;
  readonly attempts: Readonly<Record<string, unknown>>;
  readonly verification_history: ReadonlyArray<unknown>;
  readonly last_system_question: unknown;
  readonly computed_from_ledger_seq: number;
  readonly computed_at: number;
  // 兼容更多 v2.1 字段
  readonly [key: string]: unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
// 返回
// ─────────────────────────────────────────────────────────────────────────────

export interface DecideResult {
  // 决策结果
  readonly verdict: 'accept' | 'hold' | 'reject';
  readonly verdict_legacy: -2 | -1 | 0 | 1;
  readonly reason: string;
  readonly bounds: BoundsView;
  readonly reply_draft: string;
  readonly should_escalate: boolean;
  readonly structured_response?: StructuredResponse;

  /**
   * ⚠️ 关键字段（边界书 §6 + α-3 修正）：
   * ConversationRuntime 写完整 9 列 ledger + 桥接行 + actions 所需的全部材料。
   * LIOSGovernanceService 自身不写 ledger；信息通过本字段外露。
   */
  readonly ledger_payload: LedgerPayload;

  // 追溯
  readonly trace_id: string;
  readonly ledger_seq_committed?: number;

  // 调试用 pipeline 摘要（可选）
  readonly pipeline?: Readonly<Record<string, unknown>>;
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

/**
 * Ledger 写入材料。ConversationRuntime 拿到后：
 *   1) 写 lios_ledgers kernel.scored 行（用 dominant_family / structured 等）
 *   2) 写 lios_decisions + lios_actions（按 v2.1 兼容形态）
 *   3) 写兼容旧 runner 的 unified_llm_v3_pre_kernel 桥接行（用 pre_kernel_bridge）
 *   4) stagePending(actions_to_stage) 把未 committed action 入 ledger
 */
export interface LedgerPayload {
  // 主要字段（kernel.scored 行 payload 用）
  readonly dominant_family: string;
  readonly turn_family: string;
  readonly audit_layer: 'structural' | 'semantic' | 'fallback';
  readonly audit_retried: boolean;

  // 订单核验信息（独立字段，v2.1 兼容）
  readonly order_verifier_summary: string | null;
  readonly order_verifier_classification: string | null;
  readonly order_verifier_id: string | null;

  // 兼容旧 runner 的桥接行内容
  readonly pre_kernel_bridge: PreKernelBridge;

  // ActionResolver compute 出的 actions（runtime 调 stagePending）
  readonly actions_to_stage: ReadonlyArray<ResolvedActionLite>;

  // 用于 kernel.scored 行的通用 structured 字段
  readonly structured: Readonly<Record<string, unknown>>;
}

export interface PreKernelBridge {
  readonly source: 'unified_llm_v3_pre_kernel';
  readonly pre_verdict: -2 | -1 | 0 | 1;
  readonly pre_reason: string;
  readonly pre_scope: ReadonlyArray<string>;
  readonly pre_instruction: string;
  readonly attempts: number;
  readonly attempt_log: ReadonlyArray<unknown>;
  readonly user_claims_extracted: ReadonlyArray<string>;
  readonly claims_verification_status: Readonly<Record<string, string>>;
  readonly channel: string;
  readonly extracted_identifiers: ReadonlyArray<{
    readonly type: string;
    readonly value: string;
    readonly raw_text: string;
  }>;
  readonly verifications_performed: ReadonlyArray<{
    readonly result: string;
    readonly order_id: string | null;
  }>;
  readonly second_pass_verdict: number | null;
  readonly second_pass_scope: ReadonlyArray<string> | null;
  readonly extracted_order_source: string | null;
  readonly is_pure_affirmation: boolean;
}

export interface ResolvedActionLite {
  readonly action_id: string;
  readonly action_type: string;
  readonly idempotency_scope: string;
  readonly already_committed: boolean;
  readonly target_object_id?: string;
}
