/**
 * ClaimExtractor —— v2.1 语义抽取层（白皮书 §5.3）
 *
 * 职责：从用户消息抽取 Claim 数组，含两层：
 *   1) 业务主张（business claims）：refund.request / inquiry.product / order.query ...
 *   2) 元主张（meta claims）：meta.confirmation / meta.negation / meta.unclear
 *
 * 严格不做（白皮书 §3.3 + 施工方案 T3）：
 *   - 不写关键词列表（is_pure_affirmation / detect_order_source / 「聯繫人工客服」正则等）
 *   - 不做任何裁决（裁决归 Kernel）；本层只描述用户主张了什么
 *
 * v2.1 重要修正：
 *   - 用户说"正确""嗯""好的"不再输出空数组，而是抽出 meta.confirmation
 *   - meta.confirmation 必须 target = projection.last_system_question.target_slot/action
 *
 * T3 范围：
 *   - 现阶段租户策略硬编码电商配置（T5 才做 TenantPolicy 配置化）
 *   - 不接 chat.ts（T10 才接）
 */

import OpenAI from 'openai';
import { query } from '../db/client';
import type { LastSystemQuestion } from '../runtime/ConversationProjection';

// ─────────────────────────────────────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────────────────────────────────────

export type EvidenceSource =
  | 'user_assertion'
  | 'system_observation'
  | 'ledger_record'
  | 'kb_lookup'
  | 'verifier_result';

/**
 * v2.1 电商租户业务主张集（T5 之后由 TenantPolicy 配置）。
 * 命名：name.subtype；订单/退款一类放在 .request/.assertion 维度。
 */
export type BusinessClaimType =
  | 'refund.request'
  | 'order.query'
  | 'order.source_assertion'      // 替代 detect_order_source（"shopee/lazada/momo" 等平台名）
  | 'inquiry.product'
  | 'inquiry.price'
  | 'inquiry.return_policy'
  | 'inquiry.capability'          // 系统/会话内部能力问询（"能传照片吗"）
  | 'external_service.request'    // 用户请求外部服务介入（"用 foodpanda 订餐"）—— 越界
  | 'purchase.assertion'
  | 'defect.assertion'
  | 'escalation.request'          // 替代 escalation_repeat_regex（"聯繫人工客服"）
  | 'greeting'
  | 'chitchat'
  | 'unknown.business';

export type MetaClaimType =
  | 'meta.confirmation'           // "正确" / "嗯" / "好的"
  | 'meta.negation'               // "不是" / "不对"
  | 'meta.unclear';               // 输入完全无法解析

export type ClaimType = BusinessClaimType | MetaClaimType;

export interface Claim {
  readonly type: ClaimType;
  readonly content: Readonly<Record<string, unknown>>;
  readonly evidence_source: EvidenceSource;
  readonly confidence: number;     // 0..1
  readonly target?: string;        // meta-claim 必备：指向 last_system_question 的 slot/action
}

// 投影里只看一个字段：last_system_question + intent track 上下文
export interface ExtractContext {
  readonly last_system_question?: LastSystemQuestion | null;
  // 当前会话在某 intent_family 的 turn 累计 ≥1 时，含糊催促应继承 track
  // （白皮书 §4.2 律 2 推导：用户三轮换不同措辞请求同一目标是常态）
  readonly active_track?: 'dissatisfaction_track' | 'order_track' | 'inquiry_track' | null;
  readonly tenant_id?: string;
  readonly trace_id?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// LLM 客户端
// ─────────────────────────────────────────────────────────────────────────────

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = 'gpt-4o-mini';

const ALLOWED_TYPES: ReadonlyArray<ClaimType> = [
  'refund.request',
  'order.query',
  'order.source_assertion',
  'inquiry.product',
  'inquiry.price',
  'inquiry.return_policy',
  'inquiry.capability',
  'external_service.request',
  'purchase.assertion',
  'defect.assertion',
  'escalation.request',
  'greeting',
  'chitchat',
  'unknown.business',
  'meta.confirmation',
  'meta.negation',
  'meta.unclear',
];

const ALLOWED_EVIDENCE_SOURCES: ReadonlyArray<EvidenceSource> = [
  'user_assertion',
  'system_observation',
  'ledger_record',
  'kb_lookup',
  'verifier_result',
];

// ─────────────────────────────────────────────────────────────────────────────
// 主体：ClaimExtractor
// ─────────────────────────────────────────────────────────────────────────────

export class ClaimExtractor {
  /**
   * 从 user_input 抽取 claims。
   * - 不做裁决；不查 KB；不调 verifier。
   * - 仅依赖 last_system_question 给 meta.confirmation 提供 target。
   */
  async extract(userInput: string, ctx: ExtractContext = {}): Promise<Claim[]> {
    if (!userInput || userInput.trim().length === 0) {
      return [
        {
          type: 'meta.unclear',
          content: { reason: 'empty_input' },
          evidence_source: 'system_observation',
          confidence: 1.0,
        },
      ];
    }

    const systemPrompt = buildSystemPrompt(ctx.last_system_question ?? null, ctx.active_track ?? null);
    const t0 = Date.now();

    const completion = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userInput },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 500,
      temperature: 0,
    });
    const latency_ms = Date.now() - t0;

    await recordLLMCall({
      trace_id: ctx.trace_id,
      tenant_id: ctx.tenant_id,
      call_type: 'claim_extract',
      tokens_input: completion.usage?.prompt_tokens,
      tokens_output: completion.usage?.completion_tokens,
      latency_ms,
    });

    const raw = completion.choices[0]?.message?.content ?? '{}';
    const claims = parseAndValidate(raw, ctx.last_system_question ?? null);
    return claims.length > 0 ? claims : fallbackUnclear(userInput);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt 构造
// ─────────────────────────────────────────────────────────────────────────────

function buildSystemPrompt(lastQ: LastSystemQuestion | null, activeTrack: string | null): string {
  const lastQText = lastQ
    ? `上一轮系统正在等用户回答：${
        lastQ.target_slot
          ? `slot=${lastQ.target_slot}`
          : lastQ.target_action
            ? `action=${lastQ.target_action}`
            : '（未指定）'
      }`
    : '（系统当前没有 pending 的提问）';

  const trackText = activeTrack
    ? `\n当前会话已在 ${activeTrack} 跑了至少一轮。`
      + (activeTrack === 'dissatisfaction_track'
        ? '\n→ 此时用户的"含糊催促/加急"表达（"麻烦尽快帮我处理"、"快点"、"还要等多久"）应被视为 escalation.request（用户在催促处理已表达的不满），不要归为 chitchat。'
        : '')
    : '';

  return `你是 LIOS 治理系统的语义抽取层。你不做任何裁决。你的唯一任务是：
把用户消息分解成"主张（claim）"列表，输出严格 JSON。

【上下文】
${lastQText}${trackText}

【主张分两类】

A. 业务主张（business claims）—— 描述用户在业务层主张什么：
   - "refund.request"          : 用户要求退货 / 退款 / 退订
   - "order.query"             : 用户提到订单号或想查订单（content.order_id 必填）
   - "order.source_assertion"  : 用户主张订单来自哪个平台（content.source: "shopee"/"lazada"/"momo"/"website"/...）
   - "inquiry.product"         : 用户在问产品本身（content.product_name 可空）
   - "inquiry.price"           : 用户在问价格
   - "inquiry.return_policy"   : 用户在问退货 / 退款规则
   - "inquiry.capability"      : 用户问"系统/客服内部"能不能做某事（如"能传照片吗"、"能查订单状态吗"）
   - "external_service.request": 用户希望系统**调用外部服务**或**为他做客服业务范围之外的事**
                                 （如"帮我用 foodpanda 订餐"、"帮我订机票"、"用 line 联系我"、"叫快递来取件"）
   - "purchase.assertion"      : 用户主张曾购买过某物（content.what 可空）
   - "defect.assertion"        : 用户主张商品有缺陷（content.what / content.detail 可空）
   - "escalation.request"      : 用户希望转人工 / 不想继续和 AI 对话
   - "greeting"                : 打招呼
   - "chitchat"                : 闲聊，无业务诉求
   - "unknown.business"        : 业务相关但不属于以上类别

B. 元主张（meta claims）—— 描述用户对系统上一轮提问的回应：
   - "meta.confirmation"       : 用户在确认/同意（"对" / "正确" / "嗯" / "好的" / "是的"）
                                 必须设 target = 上一轮系统等的 slot/action 名（如 slot=order_id 时 target="order_id"）
   - "meta.negation"           : 用户在否认（"不对" / "不是这样"）
                                 同样必须设 target
   - "meta.unclear"            : 用户回应完全无法解析（"啊？" / "什么？" / 乱码）

【关键规则】
1. 同一句可以同时含多个主张。例如"我不想要了，我买的羽绒服是残次品" =
   refund.request + purchase.assertion + defect.assertion 三条。
2. **任何带有"之前/上次/上个月/我买的/我买过/曾经买/前几天买"等过去购买含义的句子**，
   必须额外抽出 purchase.assertion（即使主句是询问升级 / 询问产品也要带上 purchase.assertion）。
   例：「之前买的 X9 怎么升级」 = purchase.assertion + inquiry.capability（不只是 inquiry）。
3. 当系统有 pending 提问且用户输入是简短肯定 ("对"/"正确"/"嗯"/"好的"/"是的")，
   你必须输出 meta.confirmation，target 填上面给的 slot/action 名。
   不允许返回空数组。
4. 当系统没有 pending 提问时，简短肯定可视为 chitchat。
5. 不允许靠关键词（"shopee"=order_source）的形式机械判断；要看语义。
   例如"我用 shopee 下的单"=order.source_assertion；"shopee 是什么"=inquiry.product。
6. 不允许做裁决（如"该转人工"），只输出主张本身。
7. 用户提到平台名（shopee/lazada/momo/...）且语境是"在哪买的"时输出
   order.source_assertion，content.source 用小写英文。
8. **chitchat vs meta.unclear 的区分**：
   - chitchat = 用户**有连贯语义**但是闲聊/非业务（如"今天下雪"、"我喜欢猫"）。
   - meta.unclear = 用户的话**无法解析为有效意图**——乱码、断句无意义、纯试探（如"你动英文名"、"啊？"、"asdfg"）。
   - 不能把"无法解析"的输入归到 chitchat。
9. **退货意图的隐含抽取**（OI-005 修 2）：
   - 当用户输入含 defect.assertion（"是殘次品"、"壞了"、"不能用"、"有問題"）或对商品状态做负面陈述时，
     **应额外隐含抽出一条 refund.request**，content 可写 reason: "<defect 描述>"。
   - 但这条 refund.request 是**推断的**，不是用户明说的——
     **confidence 必须降一档**（约 0.55–0.7，对比明说"我要退货"的 0.85+）。
   - 例："我買的大鵝羽絨服是殘次品" =
     purchase.assertion + defect.assertion + refund.request(confidence≈0.6, content.reason="殘次品")

【证据等级 evidence_source】
- 用户口述 → "user_assertion"
- 不要使用 ledger_record / kb_lookup / verifier_result（那是后续层职责）

【置信度 confidence】
0.0~1.0，对自己抽取的把握。

【输出 JSON Schema（严格）】
{
  "claims": [
    {
      "type": "<上述任一类型>",
      "content": { ... },
      "evidence_source": "user_assertion",
      "confidence": 0.0~1.0,
      "target": "<可选；meta.* 时必填>"
    }
  ]
}

只输出 JSON，不要任何解释文字。`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 解析 + 校验 + 元主张 target 绑定
// ─────────────────────────────────────────────────────────────────────────────

function parseAndValidate(
  raw: string,
  lastQ: LastSystemQuestion | null,
): Claim[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const arr = (parsed as { claims?: unknown }).claims;
  if (!Array.isArray(arr)) return [];

  const out: Claim[] = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const type = obj.type;
    if (typeof type !== 'string' || !ALLOWED_TYPES.includes(type as ClaimType)) continue;

    let evidence_source = obj.evidence_source;
    if (typeof evidence_source !== 'string' || !ALLOWED_EVIDENCE_SOURCES.includes(evidence_source as EvidenceSource)) {
      evidence_source = 'user_assertion';
    }

    let confidence = typeof obj.confidence === 'number' ? obj.confidence : 0.6;
    confidence = Math.max(0, Math.min(1, confidence));

    const content: Record<string, unknown> =
      obj.content && typeof obj.content === 'object'
        ? { ...(obj.content as Record<string, unknown>) }
        : {};

    let target = typeof obj.target === 'string' ? obj.target : undefined;

    // 元主张：target 必须等于 projection.last_system_question 的字面值
    // 这是"结构性绑定"——LLM 的语义化 target 仅作信号，不作绑定真相源
    // (白皮书 §5.3：Runtime 把 confirmation 绑定到对应 pending 项；绑定不靠 LLM)
    if (type === 'meta.confirmation' || type === 'meta.negation') {
      const literalTarget = lastQ?.target_slot ?? lastQ?.target_action;
      if (literalTarget) {
        target = literalTarget;        // 强制覆盖
      } else {
        // 没 last_system_question 时，无从绑定 → 降级 chitchat
        out.push({
          type: 'chitchat',
          content,
          evidence_source: evidence_source as EvidenceSource,
          confidence,
        });
        continue;
      }
    }

    out.push({
      type: type as ClaimType,
      content: Object.freeze(content),
      evidence_source: evidence_source as EvidenceSource,
      confidence,
      ...(target ? { target } : {}),
    });
  }

  return out;
}

function fallbackUnclear(userInput: string): Claim[] {
  return [
    {
      type: 'meta.unclear',
      content: { sample: userInput.slice(0, 60) },
      evidence_source: 'system_observation',
      confidence: 0.5,
    },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// LLM 调用记录（与 src/services/llm.ts 同表 lios_llm_calls）
// ─────────────────────────────────────────────────────────────────────────────

async function recordLLMCall(opts: {
  trace_id?: string;
  tenant_id?: string;
  call_type: string;
  tokens_input?: number;
  tokens_output?: number;
  latency_ms: number;
}): Promise<void> {
  await query(
    `INSERT INTO lios_llm_calls
       (trace_id, tenant_id, provider, model, call_type, tokens_input, tokens_output, latency_ms)
     VALUES ($1::uuid, $2, 'openai', $3, $4, $5, $6, $7)`,
    [
      opts.trace_id ?? null,
      opts.tenant_id ?? null,
      MODEL,
      opts.call_type,
      opts.tokens_input ?? null,
      opts.tokens_output ?? null,
      opts.latency_ms,
    ],
  ).catch(() => { /* best-effort */ });
}

// 单例（业务侧 import 即用）
export const claimExtractor = new ClaimExtractor();
