import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export interface LLMAnalysis {
  intent_type:    string;
  intent_summary: string;
  confidence:     number;
  out_of_scope:   boolean;
}

export async function analyzeIntent(message: string, kbContext: string): Promise<LLMAnalysis> {
  const systemPrompt = `你是專業電商客服AI。根據下方知識庫判斷用戶問題的意圖與可回答性。

${kbContext || '（知識庫目前為空）'}

返回 JSON（不要有任何其他文字）：
{
  "intent_type": "product_inquiry|order_inquiry|return_request|price_inquiry|greeting|complaint|other",
  "intent_summary": "一句話描述用戶意圖",
  "confidence": 0.87,
  "out_of_scope": false
}

confidence 評分規則：
- 0.85-1.00：知識庫有明確直接答案
- 0.50-0.85：問題合理但需要更多資訊（例如訂單號）或知識庫只有部分相關內容
- 0.00-0.50：問題超出業務範圍或完全無法回答
out_of_scope = true：問題與電商業務完全無關（股市、天氣、政治等）`;

  const completion = await openai.chat.completions.create({
    model:           'gpt-4o-mini',
    messages:        [{ role: 'system', content: systemPrompt }, { role: 'user', content: message }],
    response_format: { type: 'json_object' },
    max_tokens:      200,
    temperature:     0.2,
  });

  const raw    = completion.choices[0]?.message?.content ?? '{}';
  const parsed = JSON.parse(raw) as Partial<LLMAnalysis>;

  return {
    intent_type:    parsed.intent_type    ?? 'other',
    intent_summary: parsed.intent_summary ?? message.slice(0, 80),
    confidence:     typeof parsed.confidence === 'number'
                      ? Math.max(0, Math.min(1, parsed.confidence)) : 0.5,
    out_of_scope:   parsed.out_of_scope === true,
  };
}

export async function generateGroundedReply(message: string, kbContext: string): Promise<string> {
  const systemPrompt = `你是企業專屬智能客服，只能根據以下知識庫內容回答用戶問題。

=== 知識庫內容 ===
${kbContext}
=== 知識庫結束 ===

硬性約束：
- 你只能使用知識庫中明確記載的資訊作答，禁止推測或補充。
- 如果知識庫內容與用戶問題無關，你必須回覆：「我目前沒有關於這個問題的資料，請聯繫人工客服（LINE：@lios-support）。」
- 不允許補充任何知識庫以外的資訊。
- 回覆請使用繁體中文，語氣專業友善，不超過 150 字。`;

  const completion = await openai.chat.completions.create({
    model:       'gpt-4o-mini',
    messages:    [{ role: 'system', content: systemPrompt }, { role: 'user', content: message }],
    max_tokens:  300,
    temperature: 0.2,
  });

  return completion.choices[0]?.message?.content?.trim()
    ?? '我目前沒有關於這個問題的資料，請聯繫人工客服（LINE：@lios-support）。';
}

export async function generateFallbackReply(
  message:  string,
  verdict:  'hold' | 'reject',
  analysis: LLMAnalysis,
): Promise<string> {
  const systemPrompt = verdict === 'hold'
    ? `你是電商客服助理。用戶問題資訊不足，請用繁體中文友善地追問。不超過80字。`
    : `你是電商客服助理。這個問題超出服務範圍，請用繁體中文禮貌說明無法回答，並建議聯繫人工客服（LINE：@lios-support，週一至週五 09:00-18:00）。不超過80字。`;

  const userContent = verdict === 'hold'
    ? `用戶問題：${message}\n意圖：${analysis.intent_summary}`
    : `用戶問題：${message}`;

  const completion = await openai.chat.completions.create({
    model:       'gpt-4o-mini',
    messages:    [{ role: 'system', content: systemPrompt }, { role: 'user', content: userContent }],
    max_tokens:  200,
    temperature: 0.4,
  });

  return completion.choices[0]?.message?.content?.trim()
    ?? (verdict === 'hold'
      ? '請提供更多詳細資訊，以便我為您服務。'
      : '暫時無法回答，建議聯繫人工客服（LINE：@lios-support）。');
}

export function buildQuickReplies(intentType: string): string[] {
  switch (intentType) {
    case 'order_inquiry':   return ['提供訂單編號', '查看物流狀態', '聯繫人工客服'];
    case 'return_request':  return ['商品有損壞', '收到錯誤商品', '聯繫人工客服'];
    case 'price_inquiry':   return ['聯繫銷售', '了解方案', '人工客服'];
    case 'product_inquiry': return ['查看更多商品', '退換貨政策', '聯繫人工客服'];
    case 'complaint':       return ['聯繫人工客服', '提交工單'];
    default:                return ['查詢訂單狀態', '退換貨申請', '商品詳情諮詢', '人工客服'];
  }
}
