/**
 * Lazada Channel Adapter — Phase 1 占位实现
 *
 * 真实接入参考（参方案文档）：
 *   - 平台门户：https://open.lazada.com/
 *   - 认证：App Key + App Secret + access_token（每 6 个月需重新授权 — 硬约束）
 *   - 多市场：单一 SDK 覆盖 SG/TH/MY/VN/PH/ID 六国，每市场单独授权
 *   - IM Open API（独立模块，专门处理客服会话）：
 *       - GET  /im/message/list        — 拉取消息列表
 *       - POST /im/sessions/send       — 发消息
 *       - GET  /im/sessions            — 会话管理
 *   - Webhook：支持但官方反馈"配置较复杂"
 *
 * 真实实现时需要：
 *   - sendReply → POST /im/sessions/send  body: {session_id, msg_type: "text", content: {text}}
 *   - TokenManager 必须建立 6 个月到期前的告警机制（见 src/auth/TokenManager.ts）
 *
 * 本 phase 只做接口契约，方法全部抛 NotImplementedError。
 */

import {
  ChannelAdapter, ChannelCapabilities, NormalizedIncomingMessage, ReplyPayload, SendResult,
  EscalationPayload, PlatformContext, HealthStatus, Platform, NotImplementedError,
} from './types';

export class LazadaChannelAdapter implements ChannelAdapter {
  readonly platform: Platform = 'lazada';

  /** Lazada 真实接入能力（占位 — 阶段二实装时按 IM Open API 文档校准） */
  readonly supported_capabilities: ChannelCapabilities = {
    text:               true,
    image_upload:       true,    // Lazada IM 支持图片
    voice:              false,
    file_upload:        false,
    buyer_order_lookup: true,
  };

  // private readonly appKey: string;
  // private readonly appSecret: string;
  // private readonly market: 'SG' | 'TH' | 'MY' | 'VN' | 'PH' | 'ID';
  // private readonly tokenManager: TokenManager;

  onIncomingMessage(_handler: (msg: NormalizedIncomingMessage) => Promise<void>): void {
    throw new NotImplementedError('LazadaChannelAdapter.onIncomingMessage not implemented in this phase');
  }

  async sendReply(_conversationId: string, _reply: ReplyPayload): Promise<SendResult> {
    throw new NotImplementedError('LazadaChannelAdapter.sendReply not implemented in this phase (target: POST /im/sessions/send)');
  }

  async escalateToHuman(_conversationId: string, _context: EscalationPayload): Promise<void> {
    throw new NotImplementedError('LazadaChannelAdapter.escalateToHuman not implemented in this phase');
  }

  async fetchConversationContext(_conversationId: string): Promise<PlatformContext> {
    throw new NotImplementedError('LazadaChannelAdapter.fetchConversationContext not implemented in this phase (target: GET /im/sessions)');
  }

  async healthCheck(): Promise<HealthStatus> {
    return {
      ok:            false,
      platform:      this.platform,
      token_valid:   false,
      api_reachable: false,
      notes:         'Phase 1 stub — adapter not configured with credentials yet',
    };
  }
}
