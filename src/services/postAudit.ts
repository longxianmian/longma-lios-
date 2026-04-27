/**
 * 事后审计：仅检查 LLM 的输出是否在 preKernel 授权范围内。
 * 不再做主防线（主防线在 preKernel 划定权限）。
 *
 * 越权情形：
 *   - verdict=0 (hold)：LLM 出了事实声明（应该只追问），违规。
 *   - verdict=-1 (reject)：LLM 长篇解释（应简短引导），违规。
 *   - verdict=+1 (accept)：LLM 引用了 scope 之外的 KB 内容或编造事实，违规。
 *   - 任何 verdict：tech 词洩漏 → 违规。
 */

import { extractAndBindFacts, FactCheckResult } from './factCheck';
import { KBSnapshot } from './kbCorpus';
import { PreKernelDecision } from './preKernel';
import { PROHIBITED_TECH_WORDS } from './replyTemplates';

export type AuditViolationType =
  | 'tech_word'
  | 'fact_in_hold'                  // verdict=0 但回复含事实
  | 'too_long_in_reject'            // verdict=-1 但太长
  | 'unbound_fact'                  // verdict=+1 但事实绑不上 KB
  | 'commitment_in_hold'            // verdict=0 但回复含「為您處理 X / 幫您辦理 X」承诺，已默认接受用户主张
  | 'fact_outside_scope'            // verdict=+1 但回复引用了 scope 外的 KB 资产
  | 'multi_question_in_compound_hold' // verdict=0 且 scope.length>=2 时，本轮问题数 >1
  | 'repeat_not_shrunk';            // 同意图已问过 ≥1 次，回复未明显缩短

export interface AuditViolation {
  type:   AuditViolationType;
  detail: string;
}

export interface AuditResult {
  passed:     boolean;
  violations: AuditViolation[];
  factCheck:  FactCheckResult;
}

// hold/reject 下禁止的「业务承诺型措辞」 — 默认接受用户主张去办理某项业务
// 注意：
//   - 不应误伤「請先提供訂單編號以便我們核對/確認/判斷」等核验话术
//   - 转人工场景（scope=escalation_intake/escalation_complete）下，「轉接 / 為您轉接 / 我將為您轉接」是合法承诺动作，不拦截
const COMMITMENT_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /為了(?:協助您|幫您|為您).{0,10}(?:處理|辦理|安排|登記).{0,6}(?:退|維修|換|安排|登記)/, label: '為了協助您處理 X 業務' },
  { re: /我(?:來|可以)?幫您(?:處理|辦理|安排).{0,8}(?:退|維修|換|登記)/,                              label: '我來幫您處理 X 業務' },
  { re: /為您(?:安排|處理|辦理).{0,8}(?:退|維修|換|登記)/,                                            label: '為您安排 X 業務' },
  { re: /請(?:您)?提供.{0,30}(?:以便|方便)(?:我們|我).{0,8}(?:處理|辦理).{0,6}(?:退|維修|換|登記)/,    label: '請提供… 以便我們處理 X' },
  { re: /我(?:會|將).{0,6}(?:為您|幫您|協助您).{0,8}(?:處理|辦理).{0,6}(?:退|維修|換|登記)/,           label: '我會為您處理 X' },
];

// escalation 场景下合法的"转接承诺"措辞，不应被 commitment 检查命中
const ESCALATION_SCOPES = new Set(['escalation_intake', 'escalation_complete']);
function isEscalationScope(scope: string[]): boolean {
  return scope.some(s => ESCALATION_SCOPES.has(s));
}

function detectCommitments(reply: string, scope: string[]): string[] {
  const hits: string[] = [];
  const inEscalation = isEscalationScope(scope);
  for (const { re, label } of COMMITMENT_PATTERNS) {
    if (re.test(reply)) hits.push(label);
  }
  // 在 escalation 场景下，过滤掉那些只是"转接动作"承诺的命中
  // 因为我们的 COMMITMENT_PATTERNS 不会匹配纯"轉接"，所以这里其实是预防性留口；
  // 但若未来 LLM 写出「我來幫您處理轉接」，仍按合法处理
  if (inEscalation) {
    return hits.filter(h => !/轉接/.test(h));
  }
  return hits;
}

// scope=["X9"] 时，"X9" 与 KB 中的 "龍碼Pro智能手環 X9" 应视为同一资产
function nameInScope(name: string, scope: string[]): boolean {
  for (const s of scope) {
    if (!s) continue;
    if (name === s) return true;
    if (name.includes(s) || s.includes(name)) return true;
  }
  return false;
}

export async function postAudit(opts: {
  reply:     string;
  preKernel: PreKernelDecision;
  kb:        KBSnapshot;
  meta?:     { traceId?: string; tenantId?: string };
}): Promise<AuditResult> {
  const violations: AuditViolation[] = [];
  const reply = opts.reply ?? '';

  // 1) 技术词洩漏 — 任何 verdict 都不能出现
  for (const w of PROHIBITED_TECH_WORDS) {
    if (reply.includes(w)) {
      violations.push({ type: 'tech_word', detail: w });
    }
  }

  // 2) 跑 factCheck 拿到具体 fact 列表（用于细分审计）
  const fc = await extractAndBindFacts(reply, opts.kb, { traceId: opts.meta?.traceId, tenantId: opts.meta?.tenantId });

  // ── verifier-driven hold scopes：核验结果已由系统证实，允许 LLM 陈述事实
  const VERIFIER_DRIVEN_HOLD_SCOPES = new Set([
    'order_overdue', 'order_already_returned', 'order_in_transit',
    'order_not_found', 'order_other_status',
  ]);
  const isVerifierDrivenHold = opts.preKernel.scope.some(s => VERIFIER_DRIVEN_HOLD_SCOPES.has(s));

  // 3) verdict=0 (hold) 系列检查 ── 禁止事实 + 禁止承诺 + 复合主张时单问
  if (opts.preKernel.verdict === 0) {
    // 仅在「非 verifier 驱动的 hold」时才禁止事实陈述。verifier-driven 场景需要陈述核验结论。
    if (!isVerifierDrivenHold && fc.facts.length > 0) {
      for (const f of fc.facts) violations.push({ type: 'fact_in_hold', detail: f.claim });
    }
    const commitments = detectCommitments(reply, opts.preKernel.scope);
    for (const c of commitments) {
      violations.push({ type: 'commitment_in_hold', detail: c });
    }
    if (opts.preKernel.scope.length >= 2) {
      const questionCount = (reply.match(/[?？]/g) ?? []).length;
      if (questionCount > 1) {
        violations.push({
          type:   'multi_question_in_compound_hold',
          detail: `本輪問句數=${questionCount}（scope=${JSON.stringify(opts.preKernel.scope)} 須單輪只問第一項：${opts.preKernel.scope[0]}）`,
        });
      }
    }
  }

  // 4) verdict=-1 (reject)：简短 + 也不能用业务承诺措辞
  if (opts.preKernel.verdict === -1) {
    if (reply.length > 60) {
      violations.push({ type: 'too_long_in_reject', detail: `len=${reply.length}（上限 60）` });
    }
    const commitments = detectCommitments(reply, opts.preKernel.scope);
    for (const c of commitments) {
      violations.push({ type: 'commitment_in_hold', detail: `[reject] ${c}` });
    }
  }

  // 4b) verdict=-2 (escalate)：极简、无 tech 词，事实校验只看 tech word（事实在第 1) 步已经查）
  if (opts.preKernel.verdict === -2) {
    if (reply.length > 80) {
      violations.push({ type: 'too_long_in_reject', detail: `escalate len=${reply.length}（上限 80）` });
    }
  }

  // 5) verdict=+1：事实必须可绑 KB；不能引用 scope 外的 KB 资产名
  //    例外：scope 含 "order:*" 时，订单内容（含 KB 产品名）由 verifier 实证，
  //    跳过 unbound_fact 和 fact_outside_scope（订单里复述 X9 是合法的）
  if (opts.preKernel.verdict === 1) {
    const hasOrderScope = opts.preKernel.scope.some(s => s.startsWith('order:'));
    if (!hasOrderScope) {
      for (const claim of fc.unbound_claims) {
        violations.push({ type: 'unbound_fact', detail: claim });
      }
      if (opts.preKernel.scope.length > 0) {
        for (const name of opts.kb.productNames) {
          if (nameInScope(name, opts.preKernel.scope)) continue;
          if (reply.includes(name)) {
            violations.push({ type: 'fact_outside_scope', detail: name });
          }
        }
      }
    }
  }

  // 7) order_not_found scope：禁止任何"查无/找不到/沒有"变体话术（避免穷举刺探）
  if (opts.preKernel.scope.includes('order_not_found')) {
    const NOT_FOUND_VARIANTS = [
      /查無此訂單/, /查无此订单/, /查不到.*訂單/, /找不到.*訂單/,
      /沒有.*訂單/, /沒有.*這筆/, /系統.*無此/, /無此記錄/,
      /無法找到/, /未能找到/, /無此筆.*訂單/,
    ];
    for (const re of NOT_FOUND_VARIANTS) {
      if (re.test(reply)) {
        violations.push({ type: 'fact_in_hold', detail: `not_found 變體：${reply.match(re)?.[0] ?? ''}（避免穷举刺探）` });
        break;
      }
    }
  }

  // 6) 任何 verdict 下：同意图重复时，回复必须明显缩短
  //    repeat_count >= 1（即第 2 次起）→ 上限 40 字
  //    repeat_count >= 2（即第 3 次起）→ 上限 35 字
  if (opts.preKernel.repeat_count >= 1) {
    const cap = opts.preKernel.repeat_count >= 2 ? 35 : 40;
    if (reply.length > cap) {
      violations.push({
        type:   'repeat_not_shrunk',
        detail: `repeat_count=${opts.preKernel.repeat_count}, len=${reply.length}（上限 ${cap}）`,
      });
    }
  }

  return {
    passed: violations.length === 0,
    violations,
    factCheck: fc,
  };
}

export function summarizeAuditForHint(audit: AuditResult, pk: PreKernelDecision): string {
  const parts: string[] = [];
  for (const v of audit.violations) {
    switch (v.type) {
      case 'tech_word':
        parts.push(`回覆出現技術詞「${v.detail}」`); break;
      case 'fact_in_hold':
        parts.push(`本輪授權為 hold (核驗/澄清)，禁止陳述事實，但你說了：「${v.detail}」`); break;
      case 'commitment_in_hold':
        parts.push(`本輪授權為 hold，但你使用了承諾性措辭「${v.detail}」—— 這已默認接受用戶主張。改為先核驗：「請先提供…以便我們確認/核對」`); break;
      case 'too_long_in_reject':
        parts.push(`本輪授權為 reject，回覆需 ≤60 字（${v.detail}）`); break;
      case 'unbound_fact':
        parts.push(`陳述「${v.detail}」無 KB 出處`); break;
      case 'fact_outside_scope':
        parts.push(`本輪授權的 scope=${JSON.stringify(pk.scope)}，但你引用了 scope 外的資產「${v.detail}」`); break;
      case 'multi_question_in_compound_hold':
        parts.push(`本輪是複合主張，scope[0]=${pk.scope[0]}。${v.detail}。本輪只能問一個問題（圍繞 scope[0]），其他維度等用戶答完再問。`); break;
      case 'repeat_not_shrunk':
        parts.push(`本輪是同意圖第 ${pk.repeat_count + 1} 次處理，${v.detail}。極簡回應，僅給核心答案，禁止複述介紹/聯繫方式/推銷話術。`); break;
    }
  }
  parts.push(`本輪指令：${pk.instruction}`);
  return parts.join('\n');
}

export function fallbackForVerdict(pk: PreKernelDecision): string {
  // scope 特例兜底（verifier 驱动场景需要确定性话术，不能转人工）
  if (pk.scope.includes('order_not_found'))         return '請您再確認一下訂單編號是否正確。';
  if (pk.scope.includes('order_overdue'))           return '此訂單已超過退貨期限，建議聯繫人工協助評估。';
  if (pk.scope.includes('order_already_returned'))  return '此訂單已申請過退貨，無法重複處理。';
  if (pk.scope.includes('order_in_transit'))        return '此訂單仍在運輸中，建議收到貨後再申請退貨。';
  if (pk.scope.includes('wrong_shop'))              return '此訂單似乎不是在本店購買，建議聯繫實際購買的商家。';

  if (pk.verdict === -1) return '感謝您的訊息，這部分不在我們服務範圍內喔。';
  if (pk.verdict === 0) return '為了能更準確協助您，請提供您的訂單編號或更多細節。';
  return '感謝您的訊息。為了更準確回覆您，我先為您轉接人工客服，請稍候。';
}
