/**
 * 治理内核（不再做意图分类 / 槽位机器，仅对 LLM 输出做三态裁决）
 *
 *   accept = facts 全部绑定 + 无技术词违规 → 放行
 *   hold   = 部分声明无法绑定，但还有重试机会 → 让 LLM 带 hint 重新推理
 *   reject = 重试用尽 / 不可恢复违规 → 兜底模板 + 转人工
 */

import { FactCheckResult, summarizeForHint } from './factCheck';

export type Verdict = 'accept' | 'hold' | 'reject';

export interface KernelInput {
  reply:         string;
  factCheck:     FactCheckResult;
  attempt:       number;     // 当前是第几次（1-based）
  maxAttempts:   number;     // 上限（含本次）
}

export interface KernelOutput {
  verdict:               Verdict;
  reason:                string;
  missing_evidence_hint: string | null;   // 仅 hold 时填，给下一轮 prompt 用
  retryable:             boolean;
}

export function judge(input: KernelInput): KernelOutput {
  const { factCheck, attempt, maxAttempts } = input;

  // 1) 全部通过 → accept
  if (factCheck.passed) {
    return {
      verdict: 'accept',
      reason:  factCheck.facts.length === 0
        ? '無事實聲明（純引導/問候），通過'
        : `${factCheck.facts.length} 條聲明全部綁定 KB`,
      missing_evidence_hint: null,
      retryable:             false,
    };
  }

  // 2) 有违规 — 判断是否可重试
  const hasUnbound = factCheck.unbound_claims.length > 0;
  const hasTechWord = factCheck.tech_word_violations.length > 0;
  const canRetry = attempt < maxAttempts;

  if (canRetry && (hasUnbound || hasTechWord)) {
    return {
      verdict: 'hold',
      reason:  `attempt ${attempt}/${maxAttempts}：unbound=${factCheck.unbound_claims.length}, tech=${factCheck.tech_word_violations.length}`,
      missing_evidence_hint: summarizeForHint(factCheck),
      retryable:             true,
    };
  }

  return {
    verdict: 'reject',
    reason:  `重試上限耗盡或不可恢復：unbound=${factCheck.unbound_claims.length}, tech=${factCheck.tech_word_violations.length}`,
    missing_evidence_hint: null,
    retryable:             false,
  };
}

export const REJECT_FALLBACK = '抱歉，這個問題我這邊無法為您準確回覆。我先為您轉接人工客服，他們會儘快回覆您。';
export const GENERIC_FALLBACK = '感謝您的訊息。為了更準確回覆您，我先為您轉接人工客服，請稍候。';
