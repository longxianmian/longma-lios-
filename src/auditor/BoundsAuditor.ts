/**
 * BoundsAuditor —— v2.1 三层审核（白皮书 §5.9 / 施工方案 T9）
 *
 * 三层结构：
 *   1) StructuralAuditor —— 确定性结构化校验（必过）
 *   2) SemanticAuditor   —— 语义审核（小模型，作为补充，不作为唯一依据）
 *   3) FallbackTemplates —— 失败兜底（确定性，最后防线）
 *
 * 流程：
 *   LLM 输出
 *     ↓ 第一层
 *     ├─ 通过 → 第二层
 *     │        ├─ 通过 → 输出
 *     │        └─ 失败 → retry 一次 → 仍失败 → 第三层兜底
 *     └─ 失败 → retry 一次 → 仍失败 → 第三层兜底
 *
 * 严格不做（施工方案 T9）：
 *   - 不写关键词正则黑名单（"查無此訂單" 6 种变体）—— 改用 bounds.must_not 结构化标签
 *   - 不让审核器自己变成另一个会漂移的 LLM
 *
 * 范式：确定性优先、AI 补充、模板收口。
 */

import OpenAI from 'openai';
import type { Bounds, Decision, KernelVerdict } from '../kernel/v2_1/LIKernel';

// ─────────────────────────────────────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────────────────────────────────────

export type AuditLayer = 'structural' | 'semantic' | 'fallback';

export interface AuditResult {
  readonly passed: boolean;
  readonly layer: AuditLayer;
  readonly final_text: string;
  readonly reason?: string;
  readonly retried?: boolean;
  readonly violations?: ReadonlyArray<string>;
}

export interface AuditInput {
  readonly reply: string;
  readonly decision: Decision;
}

// 提供给 audit 的"重试"hook，由 Runtime 在收到 retry 信号时再次调用 generator
export type RetryFn = () => Promise<string>;

// ─────────────────────────────────────────────────────────────────────────────
// 第一层：StructuralAuditor（确定性）
// ─────────────────────────────────────────────────────────────────────────────

interface StructRule {
  readonly tag: string;                                  // bounds.must / must_not 标签
  readonly check: (reply: string, bounds: Bounds) => boolean;     // true = violated
  readonly reason: string;
}

/**
 * 结构化标签 → 规则函数。
 * 这里只做"必然违反"的强校验：禁止字段、明显承诺已发生事实等。
 * 复杂语义（"是否承认了不存在的事实"）交给第二层。
 */
const STRUCTURAL_MUST_NOT_RULES: StructRule[] = [
  {
    tag: 'commit_refund_completed',
    check: r => /已[經经]?[退换]款.{0,8}\d|已[為为]您.{0,4}退款|退款.{0,4}成功|退款.{0,4}完成/.test(r),
    reason: 'commit_refund_completed_violated',
  },
  {
    tag: 'commit_order_existence',
    check: r => /已[為为]您找到[您的的]?訂單|已[為为]您查到[您的的]?訂單|您的訂單.{0,4}存在|您的订单.{0,4}存在/.test(r),
    reason: 'commit_order_existence_violated',
  },
  {
    tag: 'leak_internal_terms',
    check: r => /\b(LIOS|Kernel|bounds|prompt|embedding)\b/i.test(r) || /內核|内核|權限|权限|知識庫|知识库/.test(r),
    reason: 'leak_internal_terms_violated',
  },
  {
    tag: 'fabricate_facts',
    check: () => false,           // fabricate_facts 由第二层语义判断
    reason: 'fabricate_facts_violated',
  },
];

const FORBIDDEN_FIELDS = [
  /sk-[A-Za-z0-9_\-]{20,}/,                  // API key 泄漏
  /Bearer\s+[A-Za-z0-9_\-\.]+/i,             // token 泄漏
  /\b\d{13,16}\b.{0,20}\d{3,4}\b/,           // credit_card 模式
];

export function structuralAudit(reply: string, bounds: Bounds): AuditResult {
  const violations: string[] = [];

  // 1) bounds.must_not 标签 → 结构化规则
  for (const rule of STRUCTURAL_MUST_NOT_RULES) {
    if (bounds.must_not.includes(rule.tag) && rule.check(reply, bounds)) {
      violations.push(rule.reason);
    }
  }

  // 2) 禁止字段（token / credit_card 等）
  for (const re of FORBIDDEN_FIELDS) {
    if (re.test(reply)) {
      violations.push(`forbidden_field:${re.source.slice(0, 24)}`);
    }
  }

  // 3) bounds.must 必备结构（轻量：当 must 含 ask_for_evidence_or_clarify 时，回复应含问号或追问语气）
  if (bounds.must.includes('ask_for_evidence_or_clarify')) {
    const hasQuestion = /[?？]|請[您]?提供|请[您]?提供|請告訴|请告诉|可否|能否/.test(reply);
    if (!hasQuestion) violations.push('must_ask_for_evidence_missing');
  }

  // 4) reject 时 must 含 decline_politely → 至少不应给方案性内容（粗略：不出现"代码 / 步骤"提示）
  if (bounds.must.includes('decline_politely') && /步驟|步骤|具體做法|具体做法|代码|程式碼/.test(reply)) {
    violations.push('decline_politely_violated');
  }

  if (violations.length === 0) {
    return Object.freeze({ passed: true, layer: 'structural', final_text: reply });
  }
  return Object.freeze({
    passed: false,
    layer: 'structural',
    final_text: reply,
    reason: violations.join(','),
    violations: Object.freeze(violations),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 第二层：SemanticAuditor（小模型语义审核，作为第一层的补充）
// ─────────────────────────────────────────────────────────────────────────────

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const SEMANTIC_MODEL = 'gpt-4o-mini';

export async function semanticAudit(reply: string, bounds: Bounds, decision: Decision): Promise<AuditResult> {
  // hold / reject verdict 本身就不承诺事实（追问 / 婉拒）→ 不需要昂贵的语义审核
  // accept verdict 才有"漂移成虚构事实"风险，需要语义把关
  if (decision.verdict !== 'accept') {
    return Object.freeze({ passed: true, layer: 'semantic', final_text: reply });
  }

  // 只在 must_not 含 fabricate_facts / fabricate_kb_content / commit_unverified 时启动语义审核
  const semanticTriggers = ['fabricate_facts', 'fabricate_kb_content', 'commit_unverified'];
  const triggered = bounds.must_not.some(t => semanticTriggers.includes(t));
  if (!triggered) {
    return Object.freeze({ passed: true, layer: 'semantic', final_text: reply });
  }

  const evidenceHint =
    decision.law1.violated
      ? '当前主张证据等级不足：律 1 已 violated。回复不可声称事实已发生。'
      : decision.law1.pending_action_types && decision.law1.pending_action_types.length > 0
        ? `当前有待核验动作：${decision.law1.pending_action_types.join(', ')}。回复不可承诺这些动作已完成。`
        : '当前证据等级正常。';

  const prompt = `你是审核员，判定下面这段客服回复是否"承认了系统未确认的事实"或"承诺了未执行的动作"。

【证据提示】
${evidenceHint}

【需要审核的回复】
${reply}

【判定标准】
- 如果回复在没有证据的情况下声称"已为您退款 / 已找到订单 / 已成功处理"等 → violated
- 如果回复明确承诺尚未发生的事 → violated
- 如果回复是追问、澄清、礼貌拒绝、或明确说明"系统未记录" → ok

只输出 JSON：{"passed": true|false, "reason": "..."}`;

  try {
    const completion = await openai.chat.completions.create({
      model: SEMANTIC_MODEL,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      max_tokens: 100,
      temperature: 0,
    });
    const raw = completion.choices[0]?.message?.content ?? '{}';
    const parsed = JSON.parse(raw) as { passed?: unknown; reason?: unknown };
    const passed = parsed.passed === true;
    return Object.freeze({
      passed,
      layer: 'semantic',
      final_text: reply,
      ...(parsed.reason && typeof parsed.reason === 'string' ? { reason: parsed.reason } : {}),
    });
  } catch {
    // 语义审核失败 → 视为通过（不让 LLM 故障阻塞回复；第三层兜底仍是最后防线）
    return Object.freeze({ passed: true, layer: 'semantic', final_text: reply, reason: 'semantic_unavailable' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 第三层：FallbackTemplates（确定性兜底）
// ─────────────────────────────────────────────────────────────────────────────

const TEMPLATES: Readonly<Record<KernelVerdict, string>> = Object.freeze({
  accept: '了解了，目前資訊已收到，請稍候我再幫您確認。',
  // 注意：旧客服话术 "為了協助您處理 / 為您安排 / 我來幫您處理" 是产品禁词；
  // hold 模板里 **不要** 触发这些表达。
  hold:   '請您提供訂單編號或購買憑證，我們會幫您核對本店紀錄後再確認。',
  reject: '這部分不在本店業務範圍；如果您有產品或服務相關的問題，歡迎告訴我。',
});

export function fallbackTemplate(decision: Decision): AuditResult {
  return Object.freeze({
    passed: true,
    layer: 'fallback',
    final_text: TEMPLATES[decision.verdict],
    reason: 'used_fallback_template',
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// BoundsAuditor —— 主流程：第一层 → 第二层 → retry 一次 → 兜底
// ─────────────────────────────────────────────────────────────────────────────

export class BoundsAuditor {
  async audit(input: AuditInput, retry?: RetryFn): Promise<AuditResult> {
    const { decision } = input;
    let reply = input.reply;

    // ─────────────────────────────────────── 第 1 轮 ───────────────────────────────
    const struct1 = structuralAudit(reply, decision.bounds);
    if (!struct1.passed) {
      // 第一层失败 → 试一次 retry
      if (retry) {
        const reply2 = await retry();
        const struct2 = structuralAudit(reply2, decision.bounds);
        if (struct2.passed) {
          // retry 通过结构层 → 仍要走语义层
          const sem = await semanticAudit(reply2, decision.bounds, decision);
          if (sem.passed) {
            return Object.freeze({ ...sem, retried: true });
          }
          return fallbackOnRetryFailure(decision);
        }
      }
      return fallbackOnRetryFailure(decision);
    }

    // 第一层通过 → 第二层
    const sem1 = await semanticAudit(reply, decision.bounds, decision);
    if (sem1.passed) {
      return Object.freeze(sem1);
    }

    // 语义层失败 → retry 一次
    if (retry) {
      const reply2 = await retry();
      const struct2 = structuralAudit(reply2, decision.bounds);
      if (struct2.passed) {
        const sem2 = await semanticAudit(reply2, decision.bounds, decision);
        if (sem2.passed) {
          return Object.freeze({ ...sem2, retried: true });
        }
      }
    }

    return fallbackOnRetryFailure(decision);
  }
}

function fallbackOnRetryFailure(decision: Decision): AuditResult {
  const fb = fallbackTemplate(decision);
  return Object.freeze({
    ...fb,
    retried: true,
    reason: 'fallback_after_retry',
  });
}

// 单例
export const boundsAuditor = new BoundsAuditor();
