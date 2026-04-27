/**
 * BoundedLLMGenerator —— v2.1 约束下的最优语言生成（白皮书 §5.8 / 施工方案 T8）
 *
 * 核心原则：
 *   - 不告诉 LLM "应该说什么"
 *   - 告诉 LLM bounds.must / must_not / may
 *   - 给账本摘要 + KB 召回作为上下文
 *   - LLM 自由组织措辞、语气、节奏，**只要不违反 bounds**
 *
 * 替换：旧 promptBuilder 的角色（旧文件留作 T10/T11 参考）
 *
 * 严格不做（施工方案 T8）：
 *   - 不让 LLM 看到完整 KB（只给 retrieval 召回结果）
 *   - 不让 LLM 看到 LIKernel 内部状态
 */

import OpenAI from 'openai';
import { query } from '../db/client';
import type { Bounds, Decision } from '../kernel/v2_1/LIKernel';
import type { ConversationProjection } from '../runtime/ConversationProjection';

// ─────────────────────────────────────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────────────────────────────────────

export interface GenerateInput {
  readonly user_input: string;
  readonly decision: Decision;
  readonly projection?: ConversationProjection | null;
  readonly kb_snippets?: ReadonlyArray<string>;        // retrieval 召回片段（不要完整 KB）
  readonly history_brief?: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>;
  readonly tenant_id?: string;
  readonly trace_id?: string;
  readonly language?: 'zh-TW' | 'zh-CN' | 'en';
}

export interface GenerateOutput {
  readonly reply: string;
  readonly raw: string;
  readonly latency_ms: number;
  readonly tokens_input?: number;
  readonly tokens_output?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// LLM 客户端
// ─────────────────────────────────────────────────────────────────────────────

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = 'gpt-4o-mini';

// ─────────────────────────────────────────────────────────────────────────────
// BoundedLLMGenerator
// ─────────────────────────────────────────────────────────────────────────────

export class BoundedLLMGenerator {
  async generate(input: GenerateInput): Promise<GenerateOutput> {
    const systemPrompt = buildSystemPrompt(input);
    const messages = buildMessages(input, systemPrompt);

    const t0 = Date.now();
    const completion = await openai.chat.completions.create({
      model: MODEL,
      messages,
      max_tokens: 320,
      temperature: 0.4,         // 给 LLM 一点措辞自由度
      top_p: 0.9,
    });
    const latency_ms = Date.now() - t0;

    await recordLLMCall({
      trace_id: input.trace_id,
      tenant_id: input.tenant_id,
      call_type: 'bounded_generate',
      tokens_input: completion.usage?.prompt_tokens,
      tokens_output: completion.usage?.completion_tokens,
      latency_ms,
    });

    const raw = (completion.choices[0]?.message?.content ?? '').trim();
    return Object.freeze({
      reply: raw,                     // 审核交给 BoundsAuditor（T9）
      raw,
      latency_ms,
      tokens_input: completion.usage?.prompt_tokens,
      tokens_output: completion.usage?.completion_tokens,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt 构造（白皮书 §5.8 原则）
// ─────────────────────────────────────────────────────────────────────────────

function buildSystemPrompt(input: GenerateInput): string {
  const b: Bounds = input.decision.bounds;
  const lang = input.language ?? 'zh-TW';

  const must     = renderList(b.must);
  const must_not = renderList(b.must_not);
  const may      = renderList(b.may);

  const pendingSlot = b.pending_slot;
  const verdictHint =
    input.decision.verdict === 'accept' ? '本轮你被允许给出可承诺的回答。'
    : input.decision.verdict === 'hold'  ? (
        pendingSlot
          ? `本轮你必须以追问 ${slotPhrase(pendingSlot)} 为主要内容，不允许做事实承诺，且回复中必须明确要求用户提供 ${slotPhrase(pendingSlot)}。`
          : '本轮你必须澄清或追问，不允许做事实承诺。'
      )
    : '本轮你必须礼貌拒绝/婉拒，不要扩展话题。';

  const refHint = input.decision.referenced_actions && input.decision.referenced_actions.length > 0
    ? `\n【已存在 action 引用】上一次/早先已经处理过同类请求 (${
        input.decision.referenced_actions.map(a => a.action_type).join(', ')
      })，请引用既有结果，不要再重新触发。`
    : '';

  const escalateHint = input.decision.should_escalate
    ? '\n【升级建议】本轮已达到升级阈值；请在回复中告知用户即将转接人工，但不要替系统决定真的转接（动作由系统执行）。'
    : '';

  const kbBlock = (input.kb_snippets && input.kb_snippets.length > 0)
    ? `\n【KB 召回片段（权威来源 — 命中字段可直接引用作答；不可超越或编造其中没有的字段）】\n${input.kb_snippets.map(s => `- ${s}`).join('\n')}`
    : '\n【KB】（本轮无召回）';

  const projBlock = input.projection
    ? `\n【账本派生上下文】\n  inferred_phase: ${input.projection.inferred_phase}\n  pending_slots: ${input.projection.pending_slots.map(s => s.name).join(', ') || '（无）'}\n  pending_actions: ${input.projection.pending_actions.map(a => a.action_type).join(', ') || '（无）'}`
    : '';

  return `你是 LIOS 客服的最终回复层。你的工作不是决定**说什么**，而是决定**如何说**。
裁决与权限边界已经由治理内核（LI Kernel）给出，**你必须严格遵守 bounds**。

【语言】${lang}

【裁决】${verdictHint}${refHint}${escalateHint}

【bounds.must（必须做到）】
${must}

【bounds.must_not（不可违反）】
${must_not}

【bounds.may（可酌情）】
${may}
${kbBlock}
${projBlock}

【输出要求】
- 一句话或两句话，不超过 120 字。
- 不要复述 bounds 标签本身（must/must_not 是给你的，不是给用户的）。
- 不要泄漏 LIOS / Kernel / bounds / KB / 系统术语。
- 仅输出回复正文，不要前缀（不要"好的"开头之类的口水）。
- **如果历史里已经回答过用户当前问的同一问题（user 反复问 "X9 多少钱" / "X9 价格"），
   本次回复必须明显短于上一次**——只给核心信息（如"X9 售價 NT$ 4,990。"）即可，
   不要重复说明"包装/购买方式/保固/規格"。

【关于 KB 片段的使用】
- 当 KB 片段中已经包含用户所询问字段（如价格、规格、流程）时，**直接给出答案**，不要再追问"您指哪一款"。
- 当 KB 片段没有用户问的字段（KB 未记录）时，才说"目前未提供这部分信息"。
- 不要把 KB 中没有的内容当作 KB 中存在。

【关于 verifier-aware 标签的解读】
（这些标签如出现在 bounds.must 里，是订单核验后的语义信号。**只有当具体某个标签出现时才应用对应措辞；不要把别的标签的措辞拿来用**。）

- state_order_exists_and_in_return_window:<id>
   → **订单已被系统核验确认存在且仍在退货期**。**绝对不要再让用户确认订单号**。
   → **必须**在回复里写出订单包含的商品名（如 "龍碼Pro智能手環 X9"）和金额（如 "NT$ 4,990" 或 "4990 TWD"）——
     这些信息在【订单核验上下文】片段里有，直接引用。
   → 然后主动询问"退貨原因"。

- state_order_overdue_with_return_deadline:<id>
   → 该订单已超过退货期限；婉转说明"很抱歉，该订单已超过退货期，无法处理退货"。

- state_order_already_returned:<id>
   → 该订单先前已退货；说明"系统记录显示该订单已退货，无法重复处理"。

- state_order_in_transit:<id>
   → 订单仍在运输中；建议先收到货后再处理。

- state_order_belongs_to_other_shop:<id>
   → 此订单不属于本店；婉拒并提示"建议您联系实际下单的店铺处理"。

- ask_user_to_re_confirm_order_number
   → 系统未在本店找到此订单。**绝对不要说"查無此訂單"或"找不到訂單"**；改用"請您再確認訂單編號是否正確"或"請再次確認訂單號"等措辞。

- inform_temporary_issue_will_handoff
   → 系统暂时不可用，告诉用户即将转接人工处理。

- clarify_product_name_first:<产品名>
   → 用户提到了 <产品名>，但本店 KB 里没有完全对应的项。**先做产品澄清**（不要追问订单号）。
   → 措辞例：「您是否指『X9』？或者您能描述一下產品的特徵嗎？」
   → 在回复中至少出现以下之一：用户原词 <产品名>、KB 中接近的产品名、或"是否指"。

【bounds 通用标签译解】
- redirect_to_business_topics
   → 当 reject 时，**必须在回复中提及"業務 / 產品 / 服務"等关键词**，引导用户回到业务范围。
   → 示例措辞："抱歉，這部分不在本店業務範圍；如果您有產品或服務相關的問題，歡迎告訴我。"
- decline_politely
   → 礼貌婉拒，不解释、不延伸、不提建议性外部资源。
- use_zh_TW
   → **严格使用繁体中文**（產品 / 業務 / 服務 / 訂單 / 確認 / 沒有 / 還是）。**绝对不要输出简体**（产品 / 业务 / 服务 / 订单 / 确认 / 没有 / 还是）。即便用户用简体，你的回复也必须繁体。

如果在 bounds.must_not 里看到 commit_unverified_facts、fabricate_facts、commit_refund_completed
之类的标签——意思是这件事尚未被系统确认，你必须不暗示它已发生。`;
}

function renderList(arr: ReadonlyArray<string>): string {
  if (arr.length === 0) return '（无）';
  return arr.map(x => `  - ${x}`).join('\n');
}

function slotPhrase(slot: string): string {
  switch (slot) {
    case 'order_id':          return '訂單編號（以便我們核對本店紀錄）';
    case 'refund_reason':     return '退貨原因';
    case 'purchase_period':   return '購買日期';
    case 'defect_proof':      return '缺陷的具體情況或證據（如照片、描述）';
    case 'complaint_summary': return '需要轉人工處理的具體問題或訴求';
    case 'clarified_intent':  return '您具體想了解或處理什麼';
    default:                  return slot;
  }
}

function buildMessages(
  input: GenerateInput,
  systemPrompt: string,
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  const out: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: systemPrompt },
  ];
  if (input.history_brief) {
    for (const h of input.history_brief) out.push({ role: h.role, content: h.content });
  }
  out.push({ role: 'user', content: input.user_input });
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// LLM 调用记录
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

// 单例
export const boundedLLMGenerator = new BoundedLLMGenerator();
