/**
 * v2.2 治理决策 helpers（α-3 从 ConversationRuntime.ts 迁出）。
 *
 * 这一组函数的共同特征：**纯计算 / 决策类 IO**——
 *   - 不写 ledger
 *   - 可读 KB / 历史 intent（作为决策上下文）
 *   - 同样输入产生同样输出（ProjectionSnapshot 入参的语义保证）
 *
 * 物理位置在 src/service/ 表示它们属于"治理决策层"职责。
 * ConversationRuntime（src/runtime/）通过 import 复用——
 * runtime 仍承担 ledger 写入 + escalation_session 等编排层副作用。
 */

import { query } from '../db/client';
import type { Claim, ClaimType } from '../extractor/ClaimExtractor';
import type { EvidencePack, EvidenceLevel } from '../binder/EvidenceBinder';
import type { Decision } from '../kernel/v2_1/LIKernel';
import type { ConversationProjection } from '../runtime/ConversationProjection';
import { familyFor } from '../kernel/v2_1/ConservationLaw';
import { getKBSnapshot } from '../services/kbCorpus';
import type { ExternalEvidence } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// 主导 family 计算（律 2 累计的依据）
// ─────────────────────────────────────────────────────────────────────────────

export interface PickFamilyArgs {
  decision: Decision;
  claims: ReadonlyArray<Claim>;
  projection_already_dissatisfied: boolean;
}

export function pickDominantFamilyForTurn(args: PickFamilyArgs): string {
  const turnFamilies = new Set<string>();
  for (const c of args.decision.chosen_actions) {
    const f = familyFor(c.action_type);
    if (f !== 'unknown') turnFamilies.add(f);
  }
  if (turnFamilies.size === 0) {
    for (const cl of args.claims) {
      if (cl.type === 'escalation.request' || cl.type === 'refund.request' ||
          cl.type === 'defect.assertion'    || cl.type === 'purchase.assertion') {
        turnFamilies.add('dissatisfaction_track');
      } else if (cl.type === 'order.query') {
        turnFamilies.add('order_track');
      }
    }
  }
  const switching = args.claims.some(c =>
    c.type === 'inquiry.product' ||
    c.type === 'inquiry.price' ||
    c.type === 'inquiry.return_policy' ||
    c.type === 'chitchat' ||
    c.type === 'greeting',
  );
  if (args.projection_already_dissatisfied && !switching) {
    turnFamilies.add('dissatisfaction_track');
  }

  const priority = ['dissatisfaction_track', 'order_track', 'inquiry_track', 'meta_track'];
  for (const p of priority) if (turnFamilies.has(p)) return p;
  return 'unknown';
}

// ─────────────────────────────────────────────────────────────────────────────
// 历史与 active track 推断
// ─────────────────────────────────────────────────────────────────────────────

export async function fetchHistoryBrief(
  conversation_id: string,
  tenant_id: string,
  limit: number,
): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
  const rows = await query<{ raw_input: string }>(
    `SELECT raw_input
     FROM   lios_intents
     WHERE  session_id = $1 AND tenant_id = $2
     ORDER  BY created_at DESC
     LIMIT  $3`,
    [conversation_id, tenant_id, limit * 2],
  ).catch(() => []);
  const ordered = rows.slice().reverse().slice(-limit);
  const out: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const r of ordered) {
    out.push({ role: 'user', content: r.raw_input });
    out.push({ role: 'assistant', content: '（已答覆）' });
  }
  return out;
}

export function inferActiveTrack(
  projection: ConversationProjection,
): 'dissatisfaction_track' | 'order_track' | 'inquiry_track' | null {
  let best: { name: string; count: number } | null = null;
  for (const [key, info] of Object.entries(projection.attempts)) {
    if (!key.startsWith('family:')) continue;
    const name = key.slice('family:'.length);
    if (!best || info.count > best.count) {
      best = { name, count: info.count };
    }
  }
  if (!best || best.count < 1) return null;
  if (best.name === 'dissatisfaction_track') return 'dissatisfaction_track';
  if (best.name === 'order_track')          return 'order_track';
  if (best.name === 'inquiry_track')        return 'inquiry_track';
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Bounds 增强（基于 ExternalEvidence / 未知商品）
// ─────────────────────────────────────────────────────────────────────────────

export function detectUnknownProduct(
  claims: ReadonlyArray<Claim>,
  kbSnippets: ReadonlyArray<string>,
): string | null {
  const hasPurchase = claims.some(c => c.type === 'purchase.assertion');
  if (hasPurchase) return null;

  for (const c of claims) {
    if (c.type !== 'defect.assertion') continue;
    const cnt = c.content as Record<string, unknown>;
    const name = (cnt.product_name ?? cnt.what) as unknown;
    if (typeof name === 'string' && name.length > 0) {
      const inKB = kbSnippets.some(s => s.toLowerCase().includes(name.toLowerCase()));
      if (!inKB) return name;
    }
  }
  return null;
}

export function augmentDecisionForUnknownProduct(decision: Decision, productMentioned: string): Decision {
  const { pending_slot: _ps, pending_action: _pa, ...restBounds } = decision.bounds;
  return Object.freeze({
    ...decision,
    bounds: Object.freeze({
      ...restBounds,
      must: Object.freeze([
        ...decision.bounds.must,
        `clarify_product_name_first:${productMentioned}`,
      ]),
    }),
  });
}

/**
 * α-3 重命名（前身 augmentDecisionForVerifier）：
 * 现在统一从 ExternalEvidence 数组中提取 verifier 类信号（candidate C 设计）。
 *
 * 处理的 source/type 组合：
 *   - source='mock_order_verifier' / type='order_verification' → 提取 classification + order_id
 *
 * 未来加新 verifier 只需扩展此函数的 source/type 分支，不动 LIKernel。
 */
export function augmentDecisionFromExternalEvidence(
  decision: Decision,
  externalEvidence: ReadonlyArray<ExternalEvidence>,
): Decision {
  // 找订单核验信号
  const orderVerifyEvidence = externalEvidence.find(
    e => e.source === 'mock_order_verifier' && e.type === 'order_verification',
  );
  if (!orderVerifyEvidence) return decision;

  const data = orderVerifyEvidence.data as Record<string, unknown>;
  const classification = typeof data.classification === 'string' ? data.classification : null;
  const order_id = typeof data.order_id === 'string' ? data.order_id : null;
  if (!classification) return decision;

  // wrong_shop —— 终结性判定，verdict 强制 reject + 清掉 pending_slot
  if (classification === 'wrong_shop') {
    return Object.freeze({
      ...decision,
      verdict: 'reject',
      reason: 'verifier_wrong_shop',
      bounds: Object.freeze({
        must: Object.freeze([
          'be_polite', 'use_zh_TW',
          'decline_politely', 'redirect_to_business_topics',
          `state_order_belongs_to_other_shop:${order_id ?? ''}`,
          'decline_politely_and_suggest_correct_shop',
        ]),
        must_not: Object.freeze([
          'fabricate_facts',
          'commit_unverified',
          'leak_internal_terms',
          'use_simplified_chinese_when_zh_TW',
          'fabricate_order_id',
        ]),
        may: Object.freeze([]),
      }),
    });
  }

  // 其它 classification → bounds.must 增强
  const extraMust: string[] = [];
  switch (classification) {
    case 'exists_belongs_in_period':
      extraMust.push(
        `state_order_exists_and_in_return_window:${order_id ?? ''}`,
        'cite_kb_for_eligible_actions',
        'ask_for_refund_reason_or_proof',
      );
      break;
    case 'exists_belongs_overdue':
      extraMust.push(
        `state_order_overdue_with_return_deadline:${order_id ?? ''}`,
        'explain_overdue_politely',
      );
      break;
    case 'returned':
    case 'already_returned':
      extraMust.push(
        `state_order_already_returned:${order_id ?? ''}`,
        'explain_already_returned_politely',
      );
      break;
    case 'shipping':
    case 'in_transit':
      extraMust.push(`state_order_in_transit:${order_id ?? ''}`);
      break;
    case 'not_found':
      extraMust.push(
        'ask_user_to_re_confirm_order_number',
        'avoid_phrasing_order_does_not_exist',
      );
      break;
    case 'api_unavailable':
      extraMust.push('inform_temporary_issue_will_handoff');
      break;
  }

  return Object.freeze({
    ...decision,
    bounds: Object.freeze({
      ...decision.bounds,
      must: Object.freeze([...decision.bounds.must, ...extraMust]),
    }),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// EvidencePack 升级（KB 命中 / verifier 结果）
// ─────────────────────────────────────────────────────────────────────────────

export function upgradeInquiryEvidence(
  pack: EvidencePack,
  kbHits: ReadonlyArray<string>,
): EvidencePack {
  if (kbHits.length === 0) return pack;
  const inquiryTypes: ClaimType[] = ['inquiry.product', 'inquiry.price', 'inquiry.return_policy'];
  const bindings = pack.bindings.map(b => {
    if (!inquiryTypes.includes(b.claim.type as ClaimType)) return b;
    if (!b.pending) return b;
    return Object.freeze({
      ...b,
      evidence_source: 'kb_lookup' as const,
      evidence_level: 4 as const,
      pending: false,
      details: Object.freeze({ kb_hit: kbHits[0] }),
    });
  });
  return Object.freeze({
    bindings: Object.freeze(bindings),
    has_pending: bindings.some(b => b.pending),
    highest_level: bindings.reduce((m, b) => (b.evidence_level > m ? b.evidence_level : m), 1 as EvidenceLevel),
  });
}

export function upgradeOrderEvidence(
  pack: EvidencePack,
  order_id: string,
  classification: string,
): EvidencePack {
  const bindings = pack.bindings.map(b => {
    if (b.claim.type !== 'order.query') return b;
    const cnt = b.claim.content as { order_id?: unknown };
    if (cnt.order_id !== order_id) return b;
    return Object.freeze({
      ...b,
      evidence_source: 'verifier_result' as const,
      evidence_level: 5 as const,
      pending: false,
      details: Object.freeze({ verifier_classification: classification }),
    });
  });
  return Object.freeze({
    bindings: Object.freeze(bindings),
    has_pending: bindings.some(b => b.pending),
    highest_level: bindings.reduce((m, b) => (b.evidence_level > m ? b.evidence_level : m), 1 as EvidenceLevel),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// KB 召回
// ─────────────────────────────────────────────────────────────────────────────

export async function retrieveKBSnippets(tenant_id: string, message: string): Promise<string[]> {
  const snap = await getKBSnapshot(tenant_id).catch(() => null);
  if (!snap) return [];
  const lcMsg = message.toLowerCase();
  const tokenize = (s: string): string[] => {
    const out: string[] = [];
    for (const m of s.toLowerCase().matchAll(/([a-z0-9]{2,}|[一-鿿]{2,})/g)) {
      out.push(m[1]);
    }
    return out;
  };

  const productHits = new Set<string>();
  for (const name of snap.productNames) {
    const lcName = name.toLowerCase();
    if (lcName.length >= 2 && lcMsg.includes(lcName)) {
      productHits.add(name);
      continue;
    }
    for (const tk of tokenize(name)) {
      if (tk.length >= 2 && lcMsg.includes(tk)) {
        productHits.add(name);
        break;
      }
    }
  }
  if (productHits.size === 0) return [];

  const rows = await query<{ name: string; content: string }>(
    `SELECT name, content
     FROM   lios_assets
     WHERE  tenant_id = $1
       AND  is_indexed = TRUE
       AND  content NOT LIKE '[待轉錄：%'
       AND  content NOT LIKE '[待转录：%'`,
    [tenant_id],
  ).catch(() => []);

  const out: string[] = [];
  for (const r of rows) {
    const blob = `${r.name}\n${r.content}`.toLowerCase();
    if ([...productHits].some(m => blob.includes(m.toLowerCase()))) {
      out.push(`【${r.name}】${(r.content || '').slice(0, 400).trim()}`);
    }
  }
  return out.slice(0, 5);
}

// ─────────────────────────────────────────────────────────────────────────────
// Verdict 映射（v2.1 兼容）
// ─────────────────────────────────────────────────────────────────────────────

export function mapVerdictToLegacy(
  decision: Decision,
  alreadyCommittedHandoff: boolean,
  verifierClassification: string | null = null,
): -2 | -1 | 0 | 1 {
  if (alreadyCommittedHandoff) return -2;
  if (decision.should_escalate) return -2;

  if (verifierClassification) {
    if (verifierClassification === 'wrong_shop') return -1;
    if (verifierClassification === 'api_unavailable') return -2;
    if (verifierClassification === 'exists_belongs_in_period') return 1;
    return 0;
  }

  switch (decision.verdict) {
    case 'accept': return 1;
    case 'hold':   return 0;
    case 'reject': return -1;
  }
}

export function mapDecisionTypeForLegacy(d: Decision): 'accept' | 'reject' | 'hold' {
  return d.verdict;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pre-kernel bridge 字段合成（兼容旧 runner 的 unified_llm_v3_pre_kernel 行）
// ─────────────────────────────────────────────────────────────────────────────

export interface SynthesizeBridgeArgs {
  claims: ReadonlyArray<Claim>;
  evidence_pack: EvidencePack;
  decision: Decision;
  verifier_classification: string | null;
  verifier_order_id: string | null;
}

export function synthesizeScope(a: SynthesizeBridgeArgs): string[] {
  const scope: string[] = [];

  if (a.verifier_classification) {
    if (a.verifier_classification === 'exists_belongs_in_period') {
      scope.push(`order:${a.verifier_order_id}`);
    } else if (a.verifier_classification === 'exists_belongs_overdue') {
      scope.push('order_overdue');
    } else if (a.verifier_classification === 'wrong_shop') {
      scope.push('wrong_shop');
    } else if (a.verifier_classification === 'returned' || a.verifier_classification === 'already_returned') {
      scope.push('order_already_returned');
    } else if (a.verifier_classification === 'shipping' || a.verifier_classification === 'in_transit') {
      scope.push('order_in_transit');
    } else if (a.verifier_classification === 'not_found') {
      scope.push('order_not_found');
    } else if (a.verifier_classification === 'api_unavailable') {
      scope.push('escalation_complete');
    }
  }

  const isHold = a.decision.verdict === 'hold';
  const hasProductNameNotInKB = (() => {
    for (const b of a.evidence_pack.bindings) {
      const t = b.claim.type;
      if (t === 'purchase.assertion' || t === 'defect.assertion' ||
          t === 'inquiry.product' || t === 'inquiry.price') {
        const cnt = b.claim.content as Record<string, unknown>;
        const what = (cnt.what ?? cnt.product_name) as unknown;
        if (typeof what === 'string' && what.length > 0 && b.evidence_level < 4) {
          return true;
        }
      }
    }
    return false;
  })();

  for (const c of a.claims) {
    switch (c.type) {
      case 'inquiry.product':
      case 'inquiry.price': {
        const pn = (c.content as { product_name?: unknown }).product_name;
        if (typeof pn === 'string' && pn.length > 0) scope.push(pn);
        break;
      }
      case 'escalation.request':
        if (a.decision.should_escalate) scope.push('escalation_complete');
        else scope.push('escalation_intake');
        break;
      case 'purchase.assertion':
        if (isHold) scope.push('purchase_proof');
        break;
      case 'defect.assertion':
        if (isHold) scope.push('product_condition_evidence');
        break;
      case 'meta.unclear':
      case 'unknown.business':
        if (isHold) scope.push('intent_clarify');
        break;
    }
  }

  if (isHold && hasProductNameNotInKB) {
    scope.push('product_name_clarify');
  }

  return Array.from(new Set(scope));
}

export function synthesizeInstruction(decision: Decision): string {
  const v = decision.verdict;
  if (v === 'accept') return '可以基於已有證據作答；不要超出 KB 範圍。';
  if (v === 'hold')   return '請追問必要資訊（訂單號 / 渠道 / 證據），不要承諾未發生的事。';
  return '禮貌婉拒並引導回業務範圍。';
}

export function synthesizeClaimVerificationStatus(evidence_pack: EvidencePack): Record<string, string> {
  const out: Record<string, string> = {};
  for (const b of evidence_pack.bindings) {
    const summary = (b.claim.content as { what?: unknown }).what
      ?? (b.claim.content as { product_name?: unknown }).product_name
      ?? b.claim.type;
    const key = String(summary);
    if (b.pending) {
      out[key] = b.pending_reason === 'pending_verification' ? 'asking_now' : 'pending_evidence';
    } else {
      out[key] = 'ok';
    }
  }
  return out;
}

export function normalizeClaimForLegacy(c: Claim): string {
  switch (c.type) {
    case 'inquiry.product': return `詢問 ${(c.content as { product_name?: unknown }).product_name ?? '商品'}`;
    case 'inquiry.price':   return `詢問價格`;
    case 'order.query':     return `查詢訂單 ${(c.content as { order_id?: unknown }).order_id ?? ''}`;
    case 'refund.request':  return `退款請求`;
    case 'escalation.request': return `轉人工請求`;
    case 'purchase.assertion': {
      const what = (c.content as { what?: unknown }).what;
      return what ? `在本店購買過 ${what}` : `主張購買過`;
    }
    case 'defect.assertion': {
      const detail = (c.content as { detail?: unknown }).detail;
      return detail ? `主張缺陷 ${detail}` : `主張缺陷`;
    }
    default: return c.type;
  }
}

export function extractIdentifiers(claims: ReadonlyArray<Claim>): Array<{ type: string; value: string; raw_text: string }> {
  const ids: Array<{ type: string; value: string; raw_text: string }> = [];
  for (const c of claims) {
    const oid = (c.content as { order_id?: unknown }).order_id;
    if (typeof oid === 'string' && oid.length > 0) {
      ids.push({ type: 'order_id', value: oid, raw_text: oid });
    }
  }
  return ids;
}
