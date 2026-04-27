/**
 * ConversationRuntime —— v2.1 主控（白皮书 §5.2 / 施工方案 T10）
 *
 * 10 步主流程：
 *   1) 读取 Ledger 最新摘要
 *   2) 构建 ConversationProjection（从账本重算）
 *   3) ClaimExtractor 抽取 claims（含 meta.confirmation 绑定）
 *   4) EvidenceBinder 绑定证据
 *   5) CandidatePackBuilder 构造 KernelInput（注入 TenantPolicy）
 *   6) LIKernel 裁决
 *   7) ActionResolver 查账本守恒 / 占位 pending
 *   8) BoundedLLMGenerator 生成
 *   9) BoundsAuditor 三层审核 (含 retry / fallback)
 *   10) 写入 Ledger (含 v2.1 结构化列 + 兼容旧 runner 的 payload 行)
 *
 * 灰度：通过 chat.ts 顶部的 LIOS_RUNTIME=v2_1 feature flag 切入。
 *
 * 兼容旧测试 runner：每轮额外写一条 payload.source='unified_llm_v3_pre_kernel'
 * 的 ledger 行，含 pre_verdict / pre_scope / pre_instruction / attempts 等字段。
 */

import { randomUUID, createHash } from 'node:crypto';
import { query } from '../db/client';
import { ClaimExtractor } from '../extractor/ClaimExtractor';
import type { Claim, ClaimType } from '../extractor/ClaimExtractor';
import { EvidenceBinder } from '../binder/EvidenceBinder';
import type { EvidencePack } from '../binder/EvidenceBinder';
import { CandidatePackBuilder } from '../builder/CandidatePackBuilder';
import type { KernelInput, CandidateAction } from '../builder/CandidatePackBuilder';
import { LIKernel } from '../kernel/v2_1/LIKernel';
import type { Decision } from '../kernel/v2_1/LIKernel';
import { ActionResolver } from '../resolver/ActionResolver';
import type { ResolvedAction } from '../resolver/ActionResolver';
import { BoundedLLMGenerator } from '../generator/BoundedLLMGenerator';
import { BoundsAuditor } from '../auditor/BoundsAuditor';
import type { AuditResult } from '../auditor/BoundsAuditor';
import { ProjectionRepo } from './ProjectionRepo';
import { familyFor } from '../kernel/v2_1/ConservationLaw';
import { createEscalationSession } from '../services/agentSession';
import type { ConversationProjection } from './ConversationProjection';
import { mockOrderVerifier } from '../verifiers/MockOrderVerifier';
import { summarizeVerification } from '../verifiers/types';
import { getKBSnapshot } from '../services/kbCorpus';
import type { LiosIntent } from '../types/lios';

// ─────────────────────────────────────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────────────────────────────────────

export interface RuntimeRequest {
  readonly tenant_id: string;
  readonly session_id: string;
  readonly message: string;
  readonly lang?: string;
  readonly user_id?: string;
  readonly channel?: string;
}

export interface RuntimeResponse {
  readonly reply: string;
  readonly quick_replies: ReadonlyArray<string>;
  readonly trace_id: string;
  readonly verdict_legacy: -2 | -1 | 0 | 1;
  readonly verdict_new: 'accept' | 'hold' | 'reject';
  readonly should_escalate: boolean;
  readonly handoff_context?: HandoffContext;
  readonly pipeline: Readonly<Record<string, unknown>>;
}

/**
 * v2.1 转人工上下文（OI-005 修 1 扩展业务核心字段）。
 *
 * 字段缺失时显式标 "missing" 字面值，**不省略**——
 * agent UI / 下游消费方应能区分"未发生"与"未提取到"。
 *
 * 字段命名遵循 OI-006（v2.2 schema 规范化）的"目标字段名"：
 *   product_name / product_condition / order_id / reason
 * 当前从 ledger.claims 列做 bridge 聚合（claim.content.what → product_name 等）。
 */
export interface HandoffContext {
  readonly user_original_complaint: string;
  readonly product_name: string | 'missing';
  readonly product_condition: string | 'missing';
  readonly order_id: string | 'missing';
  readonly reason: string | 'missing';
  readonly verdict_trajectory: ReadonlyArray<string>;
  readonly collected_verification: ReadonlyArray<Record<string, unknown>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// 主控
// ─────────────────────────────────────────────────────────────────────────────

export class ConversationRuntime {
  private readonly extractor = new ClaimExtractor();
  private readonly binder = new EvidenceBinder();
  private readonly builder = new CandidatePackBuilder();
  private readonly kernel = new LIKernel();
  private readonly resolver = new ActionResolver();
  private readonly generator = new BoundedLLMGenerator();
  private readonly auditor = new BoundsAuditor();
  private readonly projectionRepo = new ProjectionRepo();

  async handle(req: RuntimeRequest): Promise<RuntimeResponse> {
    const { tenant_id, session_id, message } = req;

    // Step 0: 创建 intent（兼容现有 lios_intents 表）
    const [intent] = await query<LiosIntent>(
      `INSERT INTO lios_intents
         (tenant_id, session_id, raw_input, parsed_goal, status)
       VALUES ($1, $2, $3, $4, 'processing')
       RETURNING *`,
      [tenant_id, session_id, message, JSON.stringify({ runtime: 'v2_1' })],
    );

    // Step 1+2: ledger summary → projection
    const projection: ConversationProjection = await this.projectionRepo.forceRebuild(session_id, tenant_id);

    // Step 3: ClaimExtractor —— 传入 active_track 让 extractor 知道当前会话在哪个 intent_family
    const activeTrack = inferActiveTrack(projection);
    const claims = await this.extractor.extract(message, {
      last_system_question: projection.last_system_question,
      active_track: activeTrack,
      tenant_id,
      trace_id: intent.trace_id,
    });

    // Step 4: EvidenceBinder（先绑定基础证据）
    const kbSnap = await getKBSnapshot(tenant_id).catch(() => ({ productNames: [] as string[], kbCorpus: '' }));
    let evidencePack: EvidencePack = this.binder.bind(claims, {
      kbProductNames: kbSnap.productNames,
      tenant_id,
      ledgerHasPriorPurchase: projection.committed_actions.some(a => a.action_type === 'purchase.confirmed'),
    });

    // 4.0: KB 召回 → 升级 inquiry.* 类 binding 到 kb_lookup
    const kbSnippetsEarly = await retrieveKBSnippets(tenant_id, message);
    if (kbSnippetsEarly.length > 0) {
      evidencePack = upgradeInquiryEvidence(evidencePack, kbSnippetsEarly);
    }

    // 4.1: 若 order.query → 立刻调 verifier 升级证据等级到 verifier_result
    let verifierSummary: string | null = null;
    let verifierClassification: string | null = null;
    let verifierOrderId: string | null = null;
    const orderClaim = claims.find(c => c.type === 'order.query');
    if (orderClaim) {
      const oid = (orderClaim.content as { order_id?: unknown }).order_id;
      if (typeof oid === 'string' && oid.length > 0) {
        try {
          // shop_id 必须与 mock_orders.shop_id 对齐（demo 租户实际是 'demo'）
          // RC-4 修复：先前写死 'longma_demo' 导致所有订单都判 wrong_shop
          // 后续工程化：从 TenantPolicy.default_shop_id 取
          const v = await mockOrderVerifier.verifyByOrderId(oid, {
            tenant_id, shop_id: tenant_id,
          });
          verifierSummary = summarizeVerification(v);
          verifierClassification = v.classification;
          verifierOrderId = oid;
          // 升级该条 binding 到 verifier_result（等级 5）
          evidencePack = upgradeOrderEvidence(evidencePack, oid, v.classification);
        } catch { /* verifier 不可用 → 保留 pending_verification */ }
      }
    }

    // Step 5: CandidatePackBuilder
    const kernelInput: KernelInput = this.builder.build({
      conversation_id: session_id,
      tenant_id,
      claims,
      evidence_pack: evidencePack,
      projection,
    });

    // Step 6: LIKernel 裁决
    const decision: Decision = this.kernel.decide(kernelInput);

    // Step 7: ActionResolver 守恒
    const resolved = await this.resolver.resolve(decision.chosen_actions, {
      tenant_id, conversation_id: session_id, user_input: message, channel: req.channel,
    });
    const alreadyCommittedHandoff = resolved.find(
      a => a.action_type === 'handoff.transfer' && a.already_committed,
    );

    // 拉历史（让 LLM 知道是否已答过同问题，从而缩短/合并回复）
    const historyBrief = await fetchHistoryBrief(session_id, tenant_id, 4);

    // Step 8: BoundedLLMGenerator
    let kbSnippets = await retrieveKBSnippets(tenant_id, message);
    // verifier 返回的订单详情也注入到上下文（律 1 等级 5 来源；可被 LLM 直接引用）
    if (verifierSummary) {
      kbSnippets = [`【订单核验上下文】${verifierSummary}`, ...kbSnippets];
    }
    // 检测：用户提到了具体品名但 KB 没命中 → 应优先做产品澄清而非追问订单号
    const unknownProductMentioned = detectUnknownProduct(claims, kbSnippets);
    let decisionForGen: Decision = decision;
    if (verifierClassification) {
      decisionForGen = augmentDecisionForVerifier(decisionForGen, verifierClassification, verifierOrderId);
    }
    if (unknownProductMentioned && decisionForGen.verdict === 'hold') {
      decisionForGen = augmentDecisionForUnknownProduct(decisionForGen, unknownProductMentioned);
    }
    const genResult = await this.generator.generate({
      user_input: message,
      decision: decisionForGen,
      projection,
      kb_snippets: kbSnippets,
      history_brief: historyBrief,
      tenant_id,
      trace_id: intent.trace_id,
      language: (req.lang as 'zh-TW' | 'zh-CN' | 'en') ?? 'zh-TW',
    });

    // Step 9: BoundsAuditor 三层（传 augmented decision，让 fallback 模板与最终 verdict 对齐）
    const audited: AuditResult = await this.auditor.audit(
      { reply: genResult.reply, decision: decisionForGen },
      async () => {
        const r = await this.generator.generate({
          user_input: message,
          decision,
          projection,
          kb_snippets: kbSnippets,
          history_brief: historyBrief,
          tenant_id,
          trace_id: intent.trace_id,
          language: (req.lang as 'zh-TW' | 'zh-CN' | 'en') ?? 'zh-TW',
        });
        return r.reply;
      },
    );

    // 计算本轮 dominant family（律 2 累计依据；继承规则在此处使用 projection.attempts）
    const projectionAlreadyDissatisfied = !!projection.attempts['family:dissatisfaction_track'];
    const dominantFamilyResolved = pickDominantFamilyForTurn({
      decision, claims,
      projection_already_dissatisfied: projectionAlreadyDissatisfied,
    });

    // Step 10: 写 Ledger（含 v2.1 结构化列 + 兼容旧 runner 的 payload 行）
    await persistTurnToLedger({
      intent_id: intent.id,
      tenant_id,
      conversation_id: session_id,
      claims,
      evidence_pack: evidencePack,
      decision,
      resolved,
      audited,
      verifier_classification: verifierClassification,
      verifier_summary: verifierSummary,
      verifier_order_id: verifierOrderId,
      user_input: message,
      dominant_family: dominantFamilyResolved,
    });

    // 占位 pending（律 2 未命中的新 action 入账本 pending）
    for (const r of resolved) {
      if (!r.already_committed) {
        await this.resolver.stagePending(r, {
          tenant_id, conversation_id: session_id, user_input: message, channel: req.channel,
        }).catch(() => {});
      }
    }

    // 兜底事件（intent 关闭）
    await query(
      `UPDATE lios_intents SET status=$1, updated_at=NOW() WHERE id=$2`,
      ['completed', intent.id],
    ).catch(() => {});

    // ─── 组装响应 ───
    const verdictLegacy = mapVerdictToLegacy(decision, !!alreadyCommittedHandoff, verifierClassification);
    const handoffContext = (decision.should_escalate || verdictLegacy === -2)
      ? await buildHandoffContextFromLedger(session_id, tenant_id, message, verifierSummary)
      : undefined;

    // 写 lios_agent_sessions（runner 通过此表读 handoff_context）
    if (handoffContext && verdictLegacy === -2) {
      await createEscalationSession({
        tenant_id, session_id,
        intent_id: intent.id,
        user_message: message,
        lios_reply: audited.final_text,
        reject_reason: decision.reason,
        handoff_context: handoffContext as unknown as Record<string, unknown>,
      }).catch(err => console.error('[runtime] createEscalationSession failed:', err));
    }

    return Object.freeze({
      reply: audited.final_text,
      quick_replies: ['查詢訂單狀態', '退換貨申請', '商品詳情諮詢', '人工客服'],
      trace_id: intent.trace_id,
      verdict_legacy: verdictLegacy,
      verdict_new: decision.verdict,
      should_escalate: !!decision.should_escalate,
      ...(handoffContext ? { handoff_context: handoffContext } : {}),
      pipeline: Object.freeze({
        runtime:           'v2_1',
        kernel_verdict:    decision.verdict,
        kernel_reason:     decision.reason,
        bounds_must:       [...decision.bounds.must],
        bounds_must_not:   [...decision.bounds.must_not],
        claims_extracted:  claims.map(c => c.type),
        evidence_levels:   evidencePack.bindings.map(b => b.evidence_level),
        verifier_class:    verifierClassification,
        audit_layer:       audited.layer,
        audit_retried:     !!audited.retried,
        actions_resolved:  resolved.map(r => ({
          action_id:        r.action_id,
          action_type:      r.action_type,
          already_committed: r.already_committed,
        })),
      }),
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────

interface PickFamilyArgs {
  decision: Decision;
  claims: ReadonlyArray<Claim>;
  projection_already_dissatisfied: boolean;
}

/**
 * 决定本轮归入哪个 intent_family（律 2 turn-累计的依据）。
 *
 * 优先级：
 *   1. 当前 chosen_actions / claims 直接命中 dissatisfaction track（refund/escalation/defect/purchase）
 *   2. 若 projection 已在 dissatisfaction track 上、且本轮**没有明显话题切换**（如 inquiry.product），
 *      继承 dissatisfaction（白皮书 §4.2 律 2 推导：用户给订单号是催办过程的一部分，不是新意图）
 *   3. 否则按当前 chosen_actions / claims 派生 order_track / inquiry_track / meta_track
 *   4. 都没有 → unknown（不参与累计）
 */
function pickDominantFamilyForTurn(args: PickFamilyArgs): string {
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

async function fetchHistoryBrief(
  conversation_id: string,
  tenant_id: string,
  limit: number,
): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
  // 用最近 N 轮的 user_input + 一个简短 assistant 回应（取最后 audit 后文本无法直接 join；
  // 这里用 lios_intents.raw_input 作为 user，配以"系统已答复"占位符）
  const rows = await query<{ raw_input: string }>(
    `SELECT raw_input
     FROM   lios_intents
     WHERE  session_id = $1 AND tenant_id = $2
     ORDER  BY created_at DESC
     LIMIT  $3`,
    [conversation_id, tenant_id, limit * 2],
  ).catch(() => []);
  // 反转回时间顺序（最旧在前）；只取最近 N 轮
  const ordered = rows.slice().reverse().slice(-limit);
  const out: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const r of ordered) {
    out.push({ role: 'user', content: r.raw_input });
    out.push({ role: 'assistant', content: '（已答覆）' });
  }
  return out;
}

function inferActiveTrack(
  projection: ConversationProjection,
): 'dissatisfaction_track' | 'order_track' | 'inquiry_track' | null {
  // 从 projection.attempts 找出 turn 数最多的 family
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

function detectUnknownProduct(
  claims: ReadonlyArray<Claim>,
  kbSnippets: ReadonlyArray<string>,
): string | null {
  // 触发条件（要同时满足）：
  //  - 含 defect.assertion（用户抱怨某具体商品）
  //  - **不**含 purchase.assertion（用户没明确说过"在本店买的"——
  //    若用户已主张购买地是本店，正确顺序是先核对订单号，不是先猜品名）
  //  - claim.content 含 product_name / what 字段
  //  - 该产品名在 KB 召回片段里没出现
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

function augmentDecisionForUnknownProduct(decision: Decision, productMentioned: string): Decision {
  // 移除 pending_slot=order_id（避免 verdictHint 把"产品澄清"覆盖为"问订单号"）
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

function augmentDecisionForVerifier(
  decision: Decision,
  classification: string,
  order_id: string | null,
): Decision {
  // wrong_shop / api_unavailable —— verifier 给出"终结性"判定，无论 Kernel hold 与否，
  // 都应该把 verdict 改成对应类（reject / escalate-style hold），并清掉 pending_slot
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

  // 把 verifier classification 语义编进 bounds.must（不写关键词，写指令性标签 + 简短解释）
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
    case 'wrong_shop':
      extraMust.push(
        `state_order_belongs_to_other_shop:${order_id ?? ''}`,
        'decline_politely_and_suggest_correct_shop',
      );
      break;
    case 'not_found':
      // 关键：让 LLM "再確認訂單編號" 而非说"查無此訂單"
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

function upgradeInquiryEvidence(
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
    highest_level: bindings.reduce((m, b) => (b.evidence_level > m ? b.evidence_level : m), 1 as 1 | 2 | 3 | 4 | 5),
  });
}

function upgradeOrderEvidence(
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
    highest_level: bindings.reduce((m, b) => (b.evidence_level > m ? b.evidence_level : m), 1 as 1 | 2 | 3 | 4 | 5),
  });
}

async function retrieveKBSnippets(tenant_id: string, message: string): Promise<string[]> {
  // 双向 token 匹配：用户消息含产品 token，或产品名 token 出现在用户消息里
  const snap = await getKBSnapshot(tenant_id).catch(() => null);
  if (!snap) return [];
  const lcMsg = message.toLowerCase();
  // 取每个产品名里 "可识别 token"（长度 ≥ 2 的 ASCII/数字段或汉字段）
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
    // 反向：产品名里的某个 token 在消息里
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

function mapVerdictToLegacy(
  decision: Decision,
  alreadyCommittedHandoff: boolean,
  verifierClassification: string | null = null,
): -2 | -1 | 0 | 1 {
  if (alreadyCommittedHandoff) return -2;          // 引用既有人工转接
  if (decision.should_escalate) return -2;

  // verifier classification → 后置 legacy verdict 映射（律 1 等级 5 证据带特定语义）
  if (verifierClassification) {
    if (verifierClassification === 'wrong_shop') return -1;
    if (verifierClassification === 'api_unavailable') return -2;
    if (verifierClassification === 'exists_belongs_in_period') return 1;
    // overdue / returned / already_returned / shipping / not_found → hold
    return 0;
  }

  switch (decision.verdict) {
    case 'accept': return 1;
    case 'hold':   return 0;
    case 'reject': return -1;
  }
}

/**
 * 从 lios_ledgers 真实回放 verdict_trajectory + collected_verification + 业务核心字段。
 *
 * v2.1 + OI-005 修 1：
 *   - 从 lios_ledgers.claims 列回扫所有轮次的 claim payload
 *   - 聚合：product_name / product_condition / order_id / reason
 *   - 缺失字段标 'missing'（不省略，让 agent UI 能区分"未发生"与"未提取"）
 *
 * 字段名映射（bridge 兼容 OI-006 规范化前的命名漂移）：
 *   product_name      ← claim.content.product_name ?? content.what
 *   product_condition ← claim.content.condition    ?? content.detail
 *   order_id          ← claim.content.order_id
 *   reason            ← claim.content.reason       ?? content.refund_reason
 */
async function buildHandoffContextFromLedger(
  conversation_id: string,
  tenant_id: string,
  current_user_input: string,
  current_verifier_summary: string | null,
): Promise<HandoffContext> {
  // 拉本会话所有 kernel.scored 行 + claims 列（v9 增的结构化列）
  const rows = await query<{
    payload: { verdict?: string; verifier_summary?: string | null; reason?: string };
    claims:  unknown;
  }>(
    `SELECT payload, claims
     FROM   lios_ledgers
     WHERE  conversation_id = $1
       AND  tenant_id       = $2
       AND  event_type      = 'kernel.scored'
       AND  payload->>'runtime' = 'v2_1'
     ORDER  BY seq ASC`,
    [conversation_id, tenant_id],
  ).catch(() => []);

  // 读 user 输入（intent.created 行存了 raw_input）
  const userInputRows = await query<{ raw_input: string; created_at: string }>(
    `SELECT raw_input, created_at
     FROM   lios_intents
     WHERE  session_id = $1 AND tenant_id = $2
     ORDER  BY created_at ASC`,
    [conversation_id, tenant_id],
  ).catch(() => []);

  // verdict 轨迹
  const verdictTrajectory: string[] = rows.map(r =>
    (r.payload?.verdict as string) ?? 'unknown',
  );
  if (verdictTrajectory.length === 0 || verdictTrajectory[verdictTrajectory.length - 1] !== 'escalate') {
    verdictTrajectory.push('escalate');
  }

  // verification 历史
  const collected: Array<Record<string, unknown>> = [];
  for (const r of rows) {
    if (r.payload?.verifier_summary) {
      collected.push({ verifier: r.payload.verifier_summary });
    }
  }
  if (current_verifier_summary && !collected.some(c => c.verifier === current_verifier_summary)) {
    collected.push({ verifier: current_verifier_summary });
  }
  if (collected.length === 0) {
    collected.push({ trigger: 'family_threshold_reached', collected_at: new Date().toISOString() });
  }

  // ─── 业务核心字段聚合（OI-005 修 1）──────────────────────────────────────
  // 把所有轮次的 claims 摊平，按字段优先级取最新非空值
  const allClaims: Array<Record<string, unknown>> = [];
  for (const r of rows) {
    if (Array.isArray(r.claims)) {
      for (const c of r.claims) {
        if (c && typeof c === 'object') allClaims.push(c as Record<string, unknown>);
      }
    }
  }

  const aggregateField = (
    candidateFields: ReadonlyArray<string>,
    onlyFromTypes?: ReadonlyArray<string>,
  ): string | 'missing' => {
    // 取**首次**出现的非空值（首轮往往最具体；后续轮次的笼统词不应覆盖之前的具体词）。
    // 例：T1 "大鵝羽絨服" + T3 "產品" → 取 "大鵝羽絨服"
    //     T1 "殘次品" + T3 "質量有問題" → 取 "殘次品"
    for (let i = 0; i < allClaims.length; i++) {
      const c = allClaims[i];
      const t = c.type as string | undefined;
      if (onlyFromTypes && (typeof t !== 'string' || !onlyFromTypes.includes(t))) continue;
      const content = (c.content as Record<string, unknown> | undefined) ?? {};
      for (const f of candidateFields) {
        const v = content[f];
        if (typeof v === 'string' && v.length > 0) return v;
      }
    }
    return 'missing';
  };

  const product_name = aggregateField(
    ['product_name', 'what'],
    ['purchase.assertion', 'defect.assertion', 'inquiry.product', 'inquiry.price'],
  );
  const product_condition = aggregateField(
    ['condition', 'detail'],
    ['defect.assertion'],
  );
  const order_id = aggregateField(
    ['order_id'],
    ['order.query', 'refund.request'],
  );
  const reason = aggregateField(
    ['reason', 'refund_reason'],
    ['refund.request', 'defect.assertion', 'escalation.request'],
  );

  const userOriginalComplaint = userInputRows[0]?.raw_input ?? current_user_input;

  return Object.freeze({
    user_original_complaint: userOriginalComplaint,
    product_name,
    product_condition,
    order_id,
    reason,
    verdict_trajectory: Object.freeze(verdictTrajectory),
    collected_verification: Object.freeze(collected),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 入账本（结构化列 + 兼容旧 runner）
// ─────────────────────────────────────────────────────────────────────────────

interface PersistArgs {
  intent_id: string;
  tenant_id: string;
  conversation_id: string;
  claims: ReadonlyArray<Claim>;
  evidence_pack: EvidencePack;
  decision: Decision;
  resolved: ReadonlyArray<ResolvedAction>;
  audited: AuditResult;
  verifier_classification: string | null;
  verifier_summary: string | null;
  verifier_order_id: string | null;
  user_input: string;
  dominant_family: string;       // 已由 handle() 计算，传入即用
}

async function persistTurnToLedger(a: PersistArgs): Promise<void> {
  // a) v2.1 结构化行：写"per-turn snapshot"
  // dominant family 已由 handle() 计算并传入
  const dominantFamily = a.dominant_family;

  const turnEntityId = randomUUID();
  await query(
    `INSERT INTO lios_ledgers
       (entity_type, entity_id, event_type, payload, tenant_id,
        conversation_id, claims, evidence_pack, bounds, action_id, action_status)
     VALUES
       ('intent', $1, 'kernel.scored', $2, $3, $4, $5, $6, $7, NULL, NULL)`,
    [
      turnEntityId,
      JSON.stringify({
        runtime: 'v2_1',
        verdict: a.decision.verdict,
        reason: a.decision.reason,
        chosen_actions: a.decision.chosen_actions.map(c => c.action_type),
        verifier_summary: a.verifier_summary,
        audit_layer: a.audited.layer,
        audit_retried: !!a.audited.retried,
        // 律 2 累计依据：本轮所属语义簇（projection.attempts 自动累计）
        attempt_key: dominantFamily !== 'unknown' ? `family:${dominantFamily}` : undefined,
        turn_family: dominantFamily,
      }),
      a.tenant_id,
      a.conversation_id,
      JSON.stringify(a.claims),
      JSON.stringify(a.evidence_pack),
      JSON.stringify(a.decision.bounds),
    ],
  ).catch(err => { console.error('[runtime] write structured ledger failed:', err); });

  // b) 兼容旧 runner：source='unified_llm_v3_pre_kernel'
  const legacyDecisionId = randomUUID();
  // 先建一个最小 decision row（runner 走 join：intents→decisions→actions→ledgers）
  // 创建 candidate_pack（runner 不直接读，但 decision 表 FK 需要）
  const [pack] = await query<{ id: string }>(
    `INSERT INTO lios_candidate_packs
       (intent_id, tenant_id, name, description, score, state, source_type, metadata)
     VALUES ($1, $2, 'v2.1-runtime-pack', '', 0.9, '1', 'v2_1_runtime', '{}')
     RETURNING id`,
    [a.intent_id, a.tenant_id],
  );
  await query(
    `INSERT INTO lios_decisions
       (id, intent_id, pack_id, tenant_id, decision_type, rationale, confidence, hold_count, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8)`,
    [
      legacyDecisionId, a.intent_id, pack.id, a.tenant_id,
      mapDecisionTypeForLegacy(a.decision),
      a.decision.reason,
      0.9,
      JSON.stringify({ runtime: 'v2_1' }),
    ],
  );
  const legacyActionId = randomUUID();
  await query(
    `INSERT INTO lios_actions
       (id, decision_id, tenant_id, action_type, payload, status, idempotency_key)
     VALUES ($1, $2, $3, 'v2_1_action', '{}', 'done', $4)`,
    [legacyActionId, legacyDecisionId, a.tenant_id, `v21-${legacyActionId.slice(0, 8)}`],
  );

  // 关键：runner 查询的就是这条
  const verdictLegacy = mapVerdictToLegacy(a.decision, false, a.verifier_classification);
  const scope = synthesizeScope(a);
  const instruction = synthesizeInstruction(a);
  const attempts = a.decision.law2.repeated_pending?.[0]?.count ?? 1;
  // v2.1 是单 pass，second_pass_verdict 与 pre_verdict 同步（runner 兼容字段）
  const secondPassVerdict = a.verifier_classification ? verdictLegacy : null;

  await query(
    `INSERT INTO lios_ledgers
       (entity_type, entity_id, event_type, payload, tenant_id, conversation_id)
     VALUES ('action', $1, 'action.created', $2, $3, $4)`,
    [
      legacyActionId,
      JSON.stringify({
        source: 'unified_llm_v3_pre_kernel',
        pre_verdict:               verdictLegacy,
        pre_reason:                a.decision.reason,
        pre_scope:                 scope,
        pre_instruction:           instruction,
        attempts,
        attempt_log:               [],
        user_claims_extracted:     a.claims.map(c => normalizeClaimForLegacy(c)),
        claims_verification_status: synthesizeClaimVerificationStatus(a),
        channel:                   'demo',
        extracted_identifiers:     extractIdentifiers(a),
        verifications_performed:   a.verifier_classification
          ? [{ result: a.verifier_classification, order_id: a.verifier_order_id }]
          : [],
        second_pass_verdict:       secondPassVerdict,
        second_pass_scope:         a.verifier_classification ? scope : null,
        extracted_order_source:    null,
        is_pure_affirmation:       a.claims.some(c => c.type === 'meta.confirmation'),
      }),
      a.tenant_id,
      a.conversation_id,
    ],
  );
}

function mapDecisionTypeForLegacy(d: Decision): 'accept' | 'reject' | 'hold' {
  return d.verdict;
}

function synthesizeScope(a: PersistArgs): string[] {
  // 把 v2.1 信号转成旧 runner 期待的 scope 标签
  const scope: string[] = [];

  // 顺序敏感的特殊标签优先
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

  // claim → scope 映射（hold 时输出 legacy 兼容标签）
  const isHold = a.decision.verdict === 'hold';
  // 检测是否需要 product_name_clarify：用户提到了具体品名但 KB 没命中
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

  // 去重保持顺序
  return Array.from(new Set(scope));
}

function synthesizeInstruction(a: PersistArgs): string {
  const v = a.decision.verdict;
  if (v === 'accept') return '可以基於已有證據作答；不要超出 KB 範圍。';
  if (v === 'hold')   return '請追問必要資訊（訂單號 / 渠道 / 證據），不要承諾未發生的事。';
  return '禮貌婉拒並引導回業務範圍。';
}

function synthesizeClaimVerificationStatus(a: PersistArgs): Record<string, string> {
  const out: Record<string, string> = {};
  for (const b of a.evidence_pack.bindings) {
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

function normalizeClaimForLegacy(c: Claim): string {
  // runner 直接看是不是数组；写一段 short summary 就够
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

function extractIdentifiers(a: PersistArgs): Array<{ type: string; value: string; raw_text: string }> {
  const ids: Array<{ type: string; value: string; raw_text: string }> = [];
  for (const c of a.claims) {
    const oid = (c.content as { order_id?: unknown }).order_id;
    if (typeof oid === 'string' && oid.length > 0) {
      ids.push({ type: 'order_id', value: oid, raw_text: oid });
    }
  }
  return ids;
}

// 单例
export const conversationRuntime = new ConversationRuntime();

// 让 lint / 静态扫描通过
void createHash;
