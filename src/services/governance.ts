/**
 * 状态机决策：基于 prevState + LLMAnalysis 计算 nextState 与 verdictOverride。
 */

import { ConversationState, emptyState } from './conversationState';
import { BusinessFlow } from './businessFlows';
import { LLMAnalysis } from './llm';

export type VerdictOverride = 'accept' | 'hold' | 'reject' | null;

export interface TransitionResult {
  nextState:        ConversationState;
  verdictOverride:  VerdictOverride;   // null → 让原 Kernel 裁决
  completion_ready: boolean;           // slots 收齐了，可以执行业务动作
  active_flow:      BusinessFlow | null;
}

// 是否「孤立编号」：单纯的数字/字母编码，没动作词、没附加说明
function isOrphanCode(message: string): boolean {
  const trimmed = (message ?? '').trim();
  if (!trimmed) return false;
  // 纯字母数字 + 至少 4 字符 + 不超过 24 字符
  return /^[A-Za-z0-9_-]{4,24}$/.test(trimmed);
}

export function applyTransition(
  prev:     ConversationState,
  message:  string,
  analysis: LLMAnalysis,
  flows:    BusinessFlow[],
): TransitionResult {
  const findFlow = (key: string | null): BusinessFlow | null =>
    key ? flows.find(f => f.flow_key === key) ?? null : null;

  // 0) 硬性守卫：当无 active flow 且本轮是孤立编号时，强制不绑定流程
  //    (LLM 即便受上下文影响想绑定，也用此规则覆盖)
  if (!prev.current_flow && isOrphanCode(message)) {
    return {
      nextState: { ...prev, last_intent_text: message, hold_round: 0 },
      verdictOverride:  'hold',
      completion_ready: false,
      active_flow:      null,
    };
  }

  // 1) 用户明确切换/放弃 → 清空状态
  if (prev.current_flow && analysis.abandoned) {
    let next: ConversationState = {
      ...emptyState(prev.session_id, prev.tenant_id),
      last_intent_text: message,
    };
    // 然后看是否切换到新流程
    const newFlow = findFlow(analysis.new_intent_flow);
    if (newFlow) {
      const collected = analysis.slot_filled ?? {};
      const slotNames = newFlow.slots.map(s => s.name);
      next = {
        ...next,
        current_flow:    newFlow.flow_key,
        current_intent:  analysis.intent_summary,
        collected_slots: collected,
        missing_slots:   slotNames.filter(s => !(s in collected)),
        hold_round:      1,
      };
      return {
        nextState: next,
        verdictOverride:  next.missing_slots.length === 0 ? 'accept' : 'hold',
        completion_ready: next.missing_slots.length === 0,
        active_flow: newFlow,
      };
    }
    return { nextState: next, verdictOverride: null, completion_ready: false, active_flow: null };
  }

  // 2) 延续当前流程
  if (prev.current_flow && analysis.intent_continuation) {
    const flow = findFlow(prev.current_flow);
    if (flow) {
      const collected = { ...prev.collected_slots, ...(analysis.slot_filled ?? {}) };
      const slotNames = flow.slots.map(s => s.name);
      const missing   = slotNames.filter(s => !(s in collected) || !collected[s]);
      const next: ConversationState = {
        ...prev,
        current_intent:  analysis.intent_summary || prev.current_intent,
        collected_slots: collected,
        missing_slots:   missing,
        hold_round:      prev.hold_round + 1,
        last_intent_text: message,
        status:          missing.length === 0 ? 'completed' : 'active',
      };
      return {
        nextState: next,
        verdictOverride:  missing.length === 0 ? 'accept' : 'hold',
        completion_ready: missing.length === 0,
        active_flow: flow,
      };
    }
  }

  // 3) 启动新流程
  const newFlow = findFlow(analysis.new_intent_flow);
  if (newFlow) {
    const collected = analysis.slot_filled ?? {};
    const slotNames = newFlow.slots.map(s => s.name);
    const missing   = slotNames.filter(s => !(s in collected) || !collected[s]);
    const next: ConversationState = {
      ...emptyState(prev.session_id, prev.tenant_id),
      current_flow:    newFlow.flow_key,
      current_intent:  analysis.intent_summary,
      collected_slots: collected,
      missing_slots:   missing,
      hold_round:      1,
      last_intent_text: message,
      status:          missing.length === 0 ? 'completed' : 'active',
    };
    return {
      nextState: next,
      verdictOverride:  missing.length === 0 ? 'accept' : 'hold',
      completion_ready: missing.length === 0,
      active_flow: newFlow,
    };
  }

  // 4) 没匹配到流程：保持原状态（如果有），否则让 Kernel 自己判
  if (prev.current_flow) {
    // LLM 没判出延续也没判出新流程，但还有 active flow — 视为用户跑题/无意义，
    // 多次后建议清空（hold_round 阈值在这里软处理）
    const next: ConversationState = {
      ...prev,
      hold_round:       prev.hold_round + 1,
      last_intent_text: message,
    };
    if (next.hold_round >= 4) {
      // 跑题太多次 → 放弃流程，让原 Kernel 接手
      return {
        nextState: { ...emptyState(prev.session_id, prev.tenant_id), last_intent_text: message },
        verdictOverride: null, completion_ready: false, active_flow: null,
      };
    }
    return { nextState: next, verdictOverride: 'hold', completion_ready: false, active_flow: findFlow(prev.current_flow) };
  }

  return {
    nextState: { ...prev, last_intent_text: message },
    verdictOverride:  null,
    completion_ready: false,
    active_flow:      null,
  };
}
