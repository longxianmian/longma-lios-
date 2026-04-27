import OpenAI from 'openai';
import { query } from '../db/client';
import { sanitizeReply } from './replyTemplates';
import { ConversationTurn } from './conversationHistory';
import { BusinessFlow } from './businessFlows';
import { ConversationState } from './conversationState';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── LLMAnalysis（保留 — 旧 Kernel 仍用 confidence/out_of_scope；上下文感知字段保留以兼容） ──
export interface LLMAnalysis {
  intent_type:         string;
  intent_summary:      string;
  confidence:          number;
  out_of_scope:        boolean;
  intent_continuation: boolean;
  slot_filled:         Record<string, string>;
  new_intent_flow:     string | null;
  abandoned:           boolean;
}

async function recordLLMCall(opts: {
  trace_id?:  string;
  tenant_id?: string;
  call_type:  string;
  tokens_input?:  number;
  tokens_output?: number;
  latency_ms:  number;
}): Promise<void> {
  await query(
    `INSERT INTO lios_llm_calls
       (trace_id, tenant_id, provider, model, call_type, tokens_input, tokens_output, latency_ms)
     VALUES ($1::uuid, $2, 'openai', 'gpt-4o-mini', $3, $4, $5, $6)`,
    [opts.trace_id ?? null, opts.tenant_id ?? null, opts.call_type,
     opts.tokens_input ?? null, opts.tokens_output ?? null, opts.latency_ms],
  ).catch(() => {});
}

const GLOBAL_TAIL_FOR_ANALYZER = `

【禁詞】嚴禁出現：知識庫、知识库、資料庫、资料库、KB、系統、系统、LIOS、AI、人工智慧、人工智能、模型、prompt、匹配、索引、embedding。`;

// ── analyzeIntent：保留以兼容旧 Kernel/decisionRuntime 链路 ──────────
export interface AnalyzeContext {
  flows?:   BusinessFlow[];
  state?:   ConversationState | null;
  history?: ConversationTurn[];
}

export async function analyzeIntent(
  message:   string,
  kbContext: string,
  meta?: { trace_id?: string; tenant_id?: string },
  _ctx:  AnalyzeContext = {},
): Promise<LLMAnalysis> {
  const systemPrompt = `你是專業客服意圖分析器，輸出嚴格 JSON。

【可用內部資料】
${kbContext || '（空）'}

返回 JSON：
{
  "intent_type": "product_inquiry|order_inquiry|return_request|price_inquiry|greeting|complaint|other",
  "intent_summary": "一句話描述用戶意圖",
  "confidence": 0.0~1.0,
  "out_of_scope": bool
}

confidence：
- 0.85-1.00：資料中有明確直接答案
- 0.50-0.85：合理但需要更多資訊
- 0.00-0.50：超出業務範圍` + GLOBAL_TAIL_FOR_ANALYZER;

  const t0 = Date.now();
  const completion = await openai.chat.completions.create({
    model:           'gpt-4o-mini',
    messages:        [{ role: 'system', content: systemPrompt }, { role: 'user', content: message }],
    response_format: { type: 'json_object' },
    max_tokens:      200,
    temperature:     0,
  });
  await recordLLMCall({
    trace_id: meta?.trace_id, tenant_id: meta?.tenant_id,
    call_type: 'analyze_intent',
    tokens_input:  completion.usage?.prompt_tokens,
    tokens_output: completion.usage?.completion_tokens,
    latency_ms: Date.now() - t0,
  });

  const raw    = completion.choices[0]?.message?.content ?? '{}';
  let parsed: Partial<LLMAnalysis> = {};
  try { parsed = JSON.parse(raw) as Partial<LLMAnalysis>; } catch { /* best-effort */ }

  return {
    intent_type:         parsed.intent_type    ?? 'other',
    intent_summary:      parsed.intent_summary ?? message.slice(0, 80),
    confidence:          typeof parsed.confidence === 'number'
                            ? Math.max(0, Math.min(1, parsed.confidence)) : 0.5,
    out_of_scope:        parsed.out_of_scope === true,
    intent_continuation: false,
    slot_filled:         {},
    new_intent_flow:     null,
    abandoned:           false,
  };
}

// ── 统一回复生成器 ────────────────────────────────────────────────────
//   只负责"出一个候选"。事实校验 / Kernel 裁决 / 重试 都由调用方协调。
export interface GenerateReplyInput {
  systemPrompt: string;
  history:      ConversationTurn[];
  userMessage:  string;
  traceId?:     string;
  tenantId?:    string;
}

export interface GenerateReplyOutput {
  reply:     string;          // 已经过 sanitizeReply
  raw:       string;          // LLM 原始输出
  tokens_input?:  number;
  tokens_output?: number;
  latency_ms:     number;
}

export async function generateReply(input: GenerateReplyInput): Promise<GenerateReplyOutput> {
  // 把 history 摆成 OpenAI chat messages，最后一条是当前 userMessage
  const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
    { role: 'system', content: input.systemPrompt },
  ];
  for (const t of input.history) {
    messages.push({
      role:    t.role === 'user' ? 'user' : 'assistant',
      content: t.content,
    });
  }
  messages.push({ role: 'user', content: input.userMessage });

  const t0 = Date.now();
  const completion = await openai.chat.completions.create({
    model:       'gpt-4o-mini',
    messages,
    max_tokens:  300,
    temperature: 0,
  });
  const latency_ms = Date.now() - t0;

  await recordLLMCall({
    trace_id: input.traceId, tenant_id: input.tenantId,
    call_type: 'reply',
    tokens_input:  completion.usage?.prompt_tokens,
    tokens_output: completion.usage?.completion_tokens,
    latency_ms,
  });

  const raw = (completion.choices[0]?.message?.content ?? '').trim();
  return {
    reply: sanitizeReply(raw),
    raw,
    tokens_input:  completion.usage?.prompt_tokens,
    tokens_output: completion.usage?.completion_tokens,
    latency_ms,
  };
}

export function buildQuickReplies(_intentType: string): string[] {
  return ['提供更多資訊', '聯繫人工客服', '換一個問題'];
}
