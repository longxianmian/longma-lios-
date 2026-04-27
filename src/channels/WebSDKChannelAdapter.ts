/**
 * Web SDK Channel Adapter
 *
 * 包装现有 WebSocket 实现（src/ws/server.ts pushProgress）。
 * 不改 WebSocket 协议（前端 / 测试都无感知），只把 chat.ts 的直接耦合改成走接口调用。
 *
 * - sendReply：等价于 pushProgress(traceId, 'reply_ready', {...})
 * - escalateToHuman：等价于 createEscalationSession + pushAgentEvent（这部分仍由 chat.ts 负责
 *   写库；本 adapter 只在 ledger 上记录"事件已派发"）
 * - onIncomingMessage：当前 Web SDK 是 HTTP 入口（POST /lios/chat），不需要 push 模型，
 *   注册器作为占位接口，未来 SSE/WebSocket 双向时再扩展
 */

import { pushProgress } from '../ws/server';
import {
  ChannelAdapter, ChannelCapabilities, NormalizedIncomingMessage, ReplyPayload, SendResult,
  EscalationPayload, HealthStatus, Platform,
} from './types';

export class WebSDKChannelAdapter implements ChannelAdapter {
  readonly platform: Platform = 'web_sdk';

  /** Web SDK 当前实装的能力 — 前端只渲染文字气泡，不支持上传 */
  readonly supported_capabilities: ChannelCapabilities = {
    text:               true,
    image_upload:       false,
    voice:              false,
    file_upload:        false,
    buyer_order_lookup: false,
  };

  private incomingHandlers: Array<(msg: NormalizedIncomingMessage) => Promise<void>> = [];

  onIncomingMessage(handler: (msg: NormalizedIncomingMessage) => Promise<void>): void {
    this.incomingHandlers.push(handler);
  }

  /**
   * Web SDK 的 sendReply 用 conversationId === trace_id（chat.ts 调用时按此约定）
   * 这样既保持兼容（pushProgress 仍按 trace_id 找订阅者），又把"调用方式"统一到 adapter。
   */
  async sendReply(conversationId: string, reply: ReplyPayload): Promise<SendResult> {
    pushProgress(conversationId, 'reply_ready', {
      reply:         reply.text,
      quick_replies: reply.quick_replies ?? [],
      ...reply.meta,
    });
    return { ok: true, delivered_at: new Date().toISOString() };
  }

  /**
   * Web SDK 的转人工：实际副作用（写 lios_agent_sessions、推 agent WS 事件）
   * 仍由 chat.ts 直接调 createEscalationSession 完成。
   * 本方法只在 user-facing WS 上推一条 escalation 通知，让前端可以做 UI 切换。
   */
  async escalateToHuman(conversationId: string, _context: EscalationPayload): Promise<void> {
    pushProgress(conversationId, 'reply_ready', {
      reply:           '資料已轉給人工客服，請稍候。',
      quick_replies:   [],
      escalation:      true,
      conversation_id: conversationId,
    });
  }

  async healthCheck(): Promise<HealthStatus> {
    return {
      ok:            true,
      platform:      this.platform,
      api_reachable: true,
      notes:         'Web SDK adapter: in-process WebSocket on :3211',
    };
  }
}

// 单例：避免每次 import 重复实例化（无状态，可共享）
export const webSdkAdapter = new WebSDKChannelAdapter();
