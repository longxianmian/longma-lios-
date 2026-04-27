/**
 * Shopee Channel Adapter — Phase 1 占位实现
 *
 * 真实接入参考（参方案文档）：
 *   - API 域名：https://partner.shopeemobile.com/api/v2/
 *   - 认证：Partner ID + Partner Key + OAuth2.0（每店铺独立 access_token + refresh_token）
 *   - 签名：HMAC-SHA256（partner_key 对请求体签名）
 *   - Chat API 仅限 Seller In-house System / Customer Service 类应用
 *   - Webhook 推送：订单状态变更、聊天消息推送 → 我们的 endpoint
 *   - IP 白名单：必须在 Console 配置静态 IP
 *
 * 真实实现时需要：
 *   - sendReply  → POST https://partner.shopeemobile.com/api/v2/sellerchat/send_message
 *                  body: {to_id: buyer_user_id, message_type: "text", content: {text: ...}}
 *   - escalate   → 通过 Chat API 发"已轉人工"标记 + 在 Shopee Seller Center UI 高亮
 *   - 入口（webhook）：HMAC-SHA256 签名验证后入 Redis 队列异步处理
 *
 * 本 phase 只做接口契约，方法全部抛 NotImplementedError，让上层代码契约稳定。
 */

import {
  ChannelAdapter, ChannelCapabilities, NormalizedIncomingMessage, ReplyPayload, SendResult,
  EscalationPayload, PlatformContext, HealthStatus, Platform, NotImplementedError,
} from './types';

export class ShopeeChannelAdapter implements ChannelAdapter {
  readonly platform: Platform = 'shopee';

  /** Shopee 真实接入能力（占位 — 阶段二实装时按 API 文档校准） */
  readonly supported_capabilities: ChannelCapabilities = {
    text:               true,
    image_upload:       true,    // Shopee Chat API 支持图片
    voice:              false,
    file_upload:        false,
    buyer_order_lookup: true,    // 平台会话天然带 buyer_id
  };

  // 配置占位（真实实现需要从 lios_tenants.metadata 或独立 secrets 表加载）
  // private readonly partnerId: number;
  // private readonly partnerKey: string;
  // private readonly shopId: number;
  // private readonly tokenManager: TokenManager;

  onIncomingMessage(_handler: (msg: NormalizedIncomingMessage) => Promise<void>): void {
    throw new NotImplementedError('ShopeeChannelAdapter.onIncomingMessage not implemented in this phase');
  }

  async sendReply(_conversationId: string, _reply: ReplyPayload): Promise<SendResult> {
    throw new NotImplementedError('ShopeeChannelAdapter.sendReply not implemented in this phase (target: POST /api/v2/sellerchat/send_message)');
  }

  async escalateToHuman(_conversationId: string, _context: EscalationPayload): Promise<void> {
    throw new NotImplementedError('ShopeeChannelAdapter.escalateToHuman not implemented in this phase');
  }

  async fetchConversationContext(_conversationId: string): Promise<PlatformContext> {
    throw new NotImplementedError('ShopeeChannelAdapter.fetchConversationContext not implemented in this phase (target: GET /api/v2/sellerchat/get_conversation)');
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
