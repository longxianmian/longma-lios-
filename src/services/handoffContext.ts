/**
 * 转人工上下文打包：
 * 当 verdict=-2 (escalate) 触发时，调用 buildHandoffContext 把以下打包：
 *   - 用户原始诉求（首条 user message）
 *   - 已收集的核验信息（订单号、问题描述等）
 *   - 本会话所有 verdict 轨迹（让人工知道 AI 已经做过什么判断）
 *   - 拦截过的主张 + 已核状态（让人工知道哪些主张未核验）
 *
 * 这是 AI 与人工的"工作交接单"，避免人工接手时让用户重复说一遍。
 */

import { query } from '../db/client';

export interface VerdictTrajectoryEntry {
  turn:        number;
  user_input:  string;
  verdict:     string;       // '+1' | '0' | '-1' | '-2'
  scope:       string[];
  reason:      string;
  bot_reply:   string;
}

export interface ClaimRecord {
  claim:  string;
  status: string;             // 'asking_now' | 'blocked_by_prior_claim' | 'covered_by_kb' | 'unverified' | 'out_of_scope'
  turn:   number;
}

export interface HandoffContext {
  session_id:                string;
  tenant_id:                 string;
  user_original_complaint:   string;             // 首条用户消息（最原始诉求）
  collected_verification:    Record<string, string>; // {order_id?, issue_description?, ...} — 启发式抽取
  verdict_trajectory:        VerdictTrajectoryEntry[];
  blocked_claims:            ClaimRecord[];
  total_turns:               number;
  ai_attempts_total:         number;             // 各轮 attempts 累加
  audit_violations_total:    number;             // 各轮 attempt_log 中失败次数累加
  built_at:                  string;
}

interface IntentRow {
  trace_id:   string;
  raw_input:  string;
  created_at: string;
}
interface LedgerRow {
  payload: {
    pre_verdict?:                   string | number;
    pre_scope?:                     string[];
    pre_reason?:                    string;
    attempts?:                      string | number;
    attempt_log?:                   Array<{ raw?: string; passed?: boolean; violations?: unknown[] }>;
    user_claims_extracted?:         string[];
    claims_verification_status?:    Record<string, string>;
  };
}

/** 启发式：从历史中抽取用户给出的核验信息 */
function extractVerification(turns: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  // 订单号常见模式：4-20 位字母数字（含 -）
  for (const t of turns) {
    const m = t.match(/(?<![A-Za-z0-9_-])([A-Za-z]?[0-9]{4,16}|[A-Z]{1,4}[0-9]{3,16})(?![A-Za-z0-9_-])/);
    if (m && m[1] && m[1].length >= 4 && /[0-9]/.test(m[1])) {
      out.order_id = m[1];
      break;
    }
  }
  // 问题描述：取首条包含「壞|不|無法|問題|爆|破|損|延遲|錯|斷」的用户消息
  for (const t of turns) {
    if (/(壞|不|無法|問題|爆|破|損|延遲|錯|斷|不制冷|不開機|殘次|瑕疵|裂)/.test(t)) {
      out.issue_description = t.slice(0, 200);
      break;
    }
  }
  return out;
}

export async function buildHandoffContext(
  session_id: string,
  tenant_id:  string,
): Promise<HandoffContext> {
  // 1) 取本会话所有 user 输入（按时间序）
  const intents = await query<IntentRow>(
    `SELECT trace_id::text, raw_input, created_at
       FROM lios_intents
      WHERE session_id = $1 AND tenant_id = $2
      ORDER BY created_at ASC
      LIMIT 50`,
    [session_id, tenant_id],
  ).catch(() => []);

  // 2) 取每个 trace_id 对应的 ledger payload（含 verdict / scope / claims）
  // 通过 lios_intents → lios_decisions → lios_actions → lios_ledgers 链路取
  const traces = intents.map(i => i.trace_id);
  const ledgerByTrace = new Map<string, LedgerRow['payload']>();
  if (traces.length > 0) {
    const placeholders = traces.map((_, i) => `$${i + 1}::uuid`).join(',');
    const rows = await query<{ trace_id: string; payload: LedgerRow['payload'] }>(
      `SELECT i.trace_id::text AS trace_id, l.payload
         FROM lios_ledgers l
         JOIN lios_actions   a ON a.id = l.entity_id
         JOIN lios_decisions d ON d.id = a.decision_id
         JOIN lios_intents   i ON i.id = d.intent_id
        WHERE i.trace_id IN (${placeholders})
          AND l.event_type IN ('action.created','action.idempotent_hit')
          AND l.payload->>'source' = 'unified_llm_v3_pre_kernel'`,
      traces,
    ).catch(() => []);
    for (const r of rows) {
      // 同一 trace 可能有多条；取最新（覆盖即可，结果近似）
      ledgerByTrace.set(r.trace_id, r.payload);
    }
  }

  // 3) 拼装 trajectory + blocked_claims
  const trajectory: VerdictTrajectoryEntry[] = [];
  const blocked: ClaimRecord[] = [];
  let attemptsTotal = 0;
  let violationsTotal = 0;

  for (let i = 0; i < intents.length; i++) {
    const it = intents[i];
    const p = ledgerByTrace.get(it.trace_id) ?? {};
    const v = String(p.pre_verdict ?? '?');
    const scope = Array.isArray(p.pre_scope) ? p.pre_scope : [];
    const reason = p.pre_reason ?? '';
    const log = Array.isArray(p.attempt_log) ? p.attempt_log : [];
    const lastReply = (log[log.length - 1]?.raw ?? '').slice(0, 300);

    trajectory.push({
      turn:       i + 1,
      user_input: it.raw_input,
      verdict:    v,
      scope,
      reason,
      bot_reply:  lastReply,
    });

    attemptsTotal += parseInt(String(p.attempts ?? '0'), 10) || 0;
    for (const a of log) {
      if (a && a.passed === false) violationsTotal++;
    }

    const claims = Array.isArray(p.user_claims_extracted) ? p.user_claims_extracted : [];
    const status = (p.claims_verification_status && typeof p.claims_verification_status === 'object')
      ? p.claims_verification_status as Record<string, string>
      : {};
    for (const c of claims) {
      const st = status[c] ?? 'unverified';
      // 已 covered_by_kb 不算"待人工接力"
      if (st === 'covered_by_kb') continue;
      blocked.push({ claim: c, status: st, turn: i + 1 });
    }
  }

  // 4) 启发式从用户输入抽取已核验/已提供的信息
  const userTexts = intents.map(i => i.raw_input);
  const collected = extractVerification(userTexts);

  return {
    session_id,
    tenant_id,
    user_original_complaint:  intents[0]?.raw_input ?? '',
    collected_verification:   collected,
    verdict_trajectory:       trajectory,
    blocked_claims:           blocked,
    total_turns:              intents.length,
    ai_attempts_total:        attemptsTotal,
    audit_violations_total:   violationsTotal,
    built_at:                 new Date().toISOString(),
  };
}
