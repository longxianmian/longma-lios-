/**
 * 事实校验 — LLM-based 抽取与绑定 + 廉价正则前置过滤。
 *
 * extractAndBindFacts(reply, kb)：
 *   1) 正则扫一遍：技术词洩漏 / 出现在 KB 之外的整段【】产品引用 → 直接判失败
 *   2) 一次 LLM(temp=0) 调用：抽取 reply 中所有事实声明，对每条声明从 KB 找原文支撑
 *   3) 整合：tech_word_violations + unbound_claims + facts 详情
 *   4) all_bound = facts 全部绑定 && 无技术词违规
 */

import OpenAI from 'openai';
import { query } from '../db/client';
import { KBSnapshot } from './kbCorpus';
import { PROHIBITED_TECH_WORDS } from './replyTemplates';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export interface FactClaim {
  claim:              string;
  supporting_excerpt: string | null;
  bound:              boolean;
  reason:             string | null;   // 当 bound=false 时给出原因，可作 retry hint
}

export interface FactCheckResult {
  passed:               boolean;          // 全部通过（all_bound && 无 tech word）
  all_bound:            boolean;
  facts:                FactClaim[];
  tech_word_violations: string[];
  unbound_claims:       string[];
  raw_extractor_output: string;
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

function checkTechWords(reply: string): string[] {
  const hits: string[] = [];
  for (const w of PROHIBITED_TECH_WORDS) {
    if (reply.includes(w)) hits.push(w);
  }
  return hits;
}

const EXTRACTOR_SYSTEM = `你是嚴格但理性的事實核查員。你的任務：

1. 從「待核查回覆」中抽取每條【正向事實聲明】。正向事實聲明包括：
   - 「我們提供 X」「X 是 A 元」「保固 N 年」「防水 N 米」這類肯定陳述。
   - 訂單狀態斷言（"您的訂單已退款"、"已出貨"、"已收到您的退貨"）— 這類最高風險。

   ─── 以下不算事實聲明，請不要列出 ───
   · 問候、道歉、共情、客套；
   · 反問、追問、邀請用戶提供資訊（"請提供訂單編號"、"請問是否指 X9"）；
   · 對用戶錯誤前提的糾正（"X9 是 NT$ 4,990，不是 3,000"）— 只要正確值在 KB 中能找到，這整句算 bound；
   · 「在售清單外的產品我們沒有提供」這類**負向陳述**，只要該產品確實不在【在售清單】中，視為與 KB 一致 → bound=true，supporting_excerpt 填「在售清單僅含 X9（清單外項目視為未提供）」。
   · 「我這邊看不到此訂單」「請聯繫實際購買的平台」這類**核驗未通過後的客觀說明**，沒有具體事實內容 → 不需列出。
   · 委婉建議用戶聯繫人工客服 — 不是事實聲明。
   · 接收用戶輸入的回應（"訂單 ABC 已記錄"、"我已經記下您提供的編號"、"好的，我幫您轉接人工客服"、"已為您轉接"）— 這只是禮貌回應，**不是**對訂單系統狀態的斷言，不需列出。
   · "X 已退款 / 已出貨 / 已收到您的退貨" 這類才是真正的訂單狀態斷言（最高風險），bound=false 除非 KB 明確記載。

2. 對每條【正向事實聲明】，從【企業 KB 全文】中尋找直接支撐的原文片段（≤ 100 字）。

3. 判斷：
   - bound = true：KB 有直接記載；或屬於"清單外負向"那種與 KB 一致的陳述。
   - bound = false：KB 中找不到，且不屬於上述豁免類型。reason 一句話說明為什麼不能綁定。

4. 完全沒有事實聲明（純粹追問/澄清/共情）→ facts: []，all_bound=true。

返回 JSON（不要任何其他文字）：
{
  "facts": [
    { "claim": "...", "supporting_excerpt": "..." | null, "bound": true|false, "reason": "..." | null }
  ]
}`;

export async function extractAndBindFacts(
  reply: string,
  kb:    KBSnapshot,
  meta?: { traceId?: string; tenantId?: string },
): Promise<FactCheckResult> {
  const tech_word_violations = checkTechWords(reply);

  const trimmed = (reply ?? '').trim();
  if (!trimmed) {
    return {
      passed:               tech_word_violations.length === 0,
      all_bound:            true,
      facts:                [],
      tech_word_violations,
      unbound_claims:       [],
      raw_extractor_output: '',
    };
  }

  const userPrompt = `【在售清單】
${kb.kbSummary}

【企業 KB 全文】
${kb.kbCorpus || '（空）'}

【待核查回覆】
${trimmed}`;

  const t0 = Date.now();
  let raw = '';
  let facts: FactClaim[] = [];

  try {
    const completion = await openai.chat.completions.create({
      model:           'gpt-4o-mini',
      messages:        [
        { role: 'system', content: EXTRACTOR_SYSTEM },
        { role: 'user',   content: userPrompt },
      ],
      response_format: { type: 'json_object' },
      max_tokens:      600,
      temperature:     0,
    });
    await recordLLMCall({
      trace_id: meta?.traceId, tenant_id: meta?.tenantId,
      call_type: 'fact_check',
      tokens_input:  completion.usage?.prompt_tokens,
      tokens_output: completion.usage?.completion_tokens,
      latency_ms: Date.now() - t0,
    });
    raw = (completion.choices[0]?.message?.content ?? '').trim();
    const parsed = JSON.parse(raw) as { facts?: FactClaim[] };
    if (Array.isArray(parsed.facts)) {
      facts = parsed.facts.map(f => ({
        claim:              String(f.claim ?? '').trim(),
        supporting_excerpt: f.supporting_excerpt ? String(f.supporting_excerpt).slice(0, 200) : null,
        bound:              f.bound === true,
        reason:             f.reason ? String(f.reason).slice(0, 200) : null,
      })).filter(f => f.claim.length > 0);
    }

    // Post-filter：接收用戶輸入的回應 / 服务行为描述 不视为事实声明
    // 这些短语在客服上下文中是 acknowledgement，不是订单系统状态断言
    const ACK_PATTERNS = [
      /已記錄/, /已記下/, /已收到您的(訊息|資訊|留言)/,
      /為您轉接/, /已為您轉接/, /幫您轉接/,
      /我.*(會|將).*協助/, /稍候|稍等/,
      /謝謝您提供/, /好的.*我.*(知道|了解)/,
    ];
    const STATE_CLAIMS = [
      /已退款/, /已出貨/, /已寄出/, /已退/, /退款.*完成/,
      /訂單.*(取消|完成|送達)/,
    ];
    facts = facts.map(f => {
      if (f.bound) return f;
      const isAck = ACK_PATTERNS.some(p => p.test(f.claim));
      const isHardStateClaim = STATE_CLAIMS.some(p => p.test(f.claim));
      if (isAck && !isHardStateClaim) {
        return { ...f, bound: true, supporting_excerpt: '（接收用戶輸入的回應，非訂單系統狀態斷言）', reason: null };
      }
      return f;
    });
  } catch (err) {
    // 抽取失败：保守地放行（防止 LLM 抽取器抖动阻塞主流程）
    return {
      passed:               tech_word_violations.length === 0,
      all_bound:            true,
      facts:                [],
      tech_word_violations,
      unbound_claims:       [],
      raw_extractor_output: raw || `(extractor_error: ${(err as Error).message})`,
    };
  }

  const unbound_claims = facts.filter(f => !f.bound).map(f => f.claim);
  const all_bound = unbound_claims.length === 0;
  const passed = all_bound && tech_word_violations.length === 0;

  return {
    passed,
    all_bound,
    facts,
    tech_word_violations,
    unbound_claims,
    raw_extractor_output: raw,
  };
}

export function summarizeForHint(result: FactCheckResult): string {
  const parts: string[] = [];
  if (result.tech_word_violations.length > 0) {
    parts.push(`回覆中出現了禁用的技術詞：${result.tech_word_violations.join('、')}。請改用自然口語表達。`);
  }
  for (const f of result.facts.filter(x => !x.bound)) {
    parts.push(`「${f.claim}」無法在 KB 中找到依據${f.reason ? '：' + f.reason : ''}。`);
  }
  return parts.join('\n');
}
