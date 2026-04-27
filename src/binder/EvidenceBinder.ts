/**
 * EvidenceBinder —— 律 1（证据闭合律）的工程落地（白皮书 §4.1 / §5.4）
 *
 * 职责：把 ClaimExtractor 输出的每条 Claim 绑定到具体证据来源。
 *   evidence_source 等级（从弱到强）：
 *     1) user_assertion     —— 用户口述
 *     2) system_observation —— 系统观察（meta-claim 自身、空输入）
 *     3) ledger_record      —— 账本历史（投影/Ledger 可推断）
 *     4) kb_lookup          —— KB 命中
 *     5) verifier_result    —— 外部核验（T7 ActionResolver 才会调）
 *
 * 律 1 执行：低等级证据不能支撑高承诺度的输出；
 *   - 需要 verifier 的主张（如 order.query）：标 pending_verification
 *   - 需要 KB/账本支撑但当前空缺：标 pending_evidence
 *
 * 严格不做（施工方案 T4 不要做）：
 *   - 不调 OrderVerifier（T7 才协调外部核验）
 *   - 不修改现有 verifier 系统
 *   - 不做裁决（裁决归 Kernel）
 */

import type {
  Claim,
  ClaimType,
  EvidenceSource,
} from '../extractor/ClaimExtractor';

// ─────────────────────────────────────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────────────────────────────────────

export type EvidenceLevel = 1 | 2 | 3 | 4 | 5;

export type PendingReason =
  | 'pending_evidence'        // 需要更强证据（KB/账本/verifier）但当前空缺
  | 'pending_verification';   // 等待外部核验（如订单 verifier）

export interface EvidenceBinding {
  readonly claim: Claim;
  readonly evidence_source: EvidenceSource;
  readonly evidence_level: EvidenceLevel;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly pending: boolean;
  readonly pending_reason?: PendingReason;
}

export interface EvidencePack {
  readonly bindings: ReadonlyArray<EvidenceBinding>;
  readonly has_pending: boolean;
  readonly highest_level: EvidenceLevel;
}

// 输入选项（可注入 KB 白名单与最近账本指纹，免 DB 依赖便于单测）
export interface BindOptions {
  readonly kbProductNames?: ReadonlyArray<string>;
  readonly ledgerHasPriorPurchase?: boolean;     // 投影侧给出的简化指纹
  readonly tenant_id?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// EvidenceBinder
// ─────────────────────────────────────────────────────────────────────────────

const LEVEL: Readonly<Record<EvidenceSource, EvidenceLevel>> = Object.freeze({
  user_assertion:     1,
  system_observation: 2,
  ledger_record:      3,
  kb_lookup:          4,
  verifier_result:    5,
});

export class EvidenceBinder {
  /**
   * 给定 claims，返回 EvidencePack。
   * - 不会改写 claim 本身；新建 EvidenceBinding 包装
   * - 不调 verifier；不查 DB（KB 命中由调用方传入名单）
   */
  bind(claims: ReadonlyArray<Claim>, opts: BindOptions = {}): EvidencePack {
    const kbSet = new Set(
      (opts.kbProductNames ?? []).map(s => s.toLowerCase()),
    );
    const bindings: EvidenceBinding[] = claims.map(c =>
      bindOne(c, kbSet, opts),
    );
    const has_pending = bindings.some(b => b.pending);
    const highest_level = bindings.reduce<EvidenceLevel>(
      (max, b) => (b.evidence_level > max ? b.evidence_level : max),
      1,
    );
    return Object.freeze({
      bindings: Object.freeze(bindings),
      has_pending,
      highest_level,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 单条绑定逻辑（按 claim.type 分发）
// ─────────────────────────────────────────────────────────────────────────────

function bindOne(
  claim: Claim,
  kbSet: Set<string>,
  opts: BindOptions,
): EvidenceBinding {
  const t: ClaimType = claim.type;

  // 1) meta-claims：系统观察（不是用户陈述事实，而是用户在确认/否认/不解）
  if (t === 'meta.confirmation' || t === 'meta.negation' || t === 'meta.unclear') {
    return mk(claim, 'system_observation', false);
  }

  // 2) inquiry.* —— 通常需要 KB 命中作为强证据
  if (t === 'inquiry.product' || t === 'inquiry.price' || t === 'inquiry.return_policy') {
    const hit = matchKB(claim, kbSet);
    if (hit) {
      return mk(claim, 'kb_lookup', false, { kb_hit: hit });
    }
    // KB 未命中：律 1 要求"系统未记录时明确声明未记录"——标 pending_evidence
    return mk(claim, 'user_assertion', true, undefined, 'pending_evidence');
  }

  // 3) inquiry.capability —— 系统能力问询，可由系统观察直接回答（无需 KB）
  if (t === 'inquiry.capability') {
    return mk(claim, 'system_observation', false);
  }

  // 4) order.query —— 等 T7 外部核验
  if (t === 'order.query') {
    return mk(claim, 'user_assertion', true, undefined, 'pending_verification');
  }

  // 5) order.source_assertion —— 用户主张订单平台来源；本身只是 user_assertion
  if (t === 'order.source_assertion') {
    return mk(claim, 'user_assertion', false);
  }

  // 6) purchase.assertion —— 用户主张曾购买；可被账本（ledger_record）佐证
  if (t === 'purchase.assertion') {
    if (opts.ledgerHasPriorPurchase) {
      return mk(claim, 'ledger_record', false, { from: 'projection' });
    }
    // 否则只有 user_assertion，且需要更强证据：标 pending_evidence
    return mk(claim, 'user_assertion', true, undefined, 'pending_evidence');
  }

  // 7) defect.assertion —— 用户主张商品有缺陷；只有 user_assertion，需要图片/订单核验
  if (t === 'defect.assertion') {
    return mk(claim, 'user_assertion', true, undefined, 'pending_evidence');
  }

  // 8) refund.request / escalation.request —— 是诉求不是事实；user_assertion 即可
  if (t === 'refund.request' || t === 'escalation.request') {
    return mk(claim, 'user_assertion', false);
  }

  // 9) greeting / chitchat / unknown.business —— 不需要证据闭合
  if (t === 'greeting' || t === 'chitchat') {
    return mk(claim, 'user_assertion', false);
  }
  if (t === 'unknown.business') {
    return mk(claim, 'user_assertion', true, undefined, 'pending_evidence');
  }

  // 兜底：当作 user_assertion + pending_evidence
  return mk(claim, 'user_assertion', true, undefined, 'pending_evidence');
}

function matchKB(claim: Claim, kbSet: Set<string>): string | null {
  if (kbSet.size === 0) return null;
  const candidates = collectClaimStrings(claim);
  for (const cand of candidates) {
    const lc = cand.toLowerCase();
    // 完整匹配优先
    if (kbSet.has(lc)) return cand;
    // 子串匹配（KB 名嵌在用户描述里）
    for (const name of kbSet) {
      if (name.length >= 2 && lc.includes(name)) return name;
    }
  }
  return null;
}

function collectClaimStrings(claim: Claim): string[] {
  const out: string[] = [];
  const cnt = claim.content as Record<string, unknown>;
  for (const [k, v] of Object.entries(cnt)) {
    if (typeof v === 'string' && v.length > 0) out.push(v);
    if (k === 'product_name' && typeof v === 'string') out.unshift(v);  // 优先级
  }
  return out;
}

function mk(
  claim: Claim,
  source: EvidenceSource,
  pending: boolean,
  details?: Record<string, unknown>,
  pending_reason?: PendingReason,
): EvidenceBinding {
  return Object.freeze({
    claim,
    evidence_source: source,
    evidence_level: LEVEL[source],
    ...(details ? { details: Object.freeze({ ...details }) } : {}),
    pending,
    ...(pending_reason ? { pending_reason } : {}),
  });
}

// 单例
export const evidenceBinder = new EvidenceBinder();
