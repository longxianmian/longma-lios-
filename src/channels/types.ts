/**
 * Channel Adapter 抽象层
 *
 * 同一套 LIOS Core（preKernel/postAudit/promptBuilder/LLM）服务多个渠道。
 * 平台差异（Web SDK / Shopee / Lazada / TikTok Shop ...）封装在 ChannelAdapter 实现里。
 *
 * Core 只看到标准化结构：NormalizedIncomingMessage / ReplyPayload / EscalationPayload。
 *
 * 参考方案文档：
 *   ~/Documents/龙码协议/龙码LIOS系统/LIOS × Shopee:Lazada 第三方对接方案（基于官方文档核实）.md
 */

export type Platform = 'web_sdk' | 'shopee' | 'lazada' | 'tiktok_shop';

export interface Attachment {
  type:  'image' | 'video' | 'file' | 'audio';
  url:   string;
  name?: string;
  size?: number;
}

export interface NormalizedIncomingMessage {
  platform:        Platform;
  tenant_id:       string;          // LIOS 租户 ID
  shop_id:         string;          // 平台 shop_id（Shopee shopid / Lazada seller_id）
  conversation_id: string;          // 平台原生会话 ID
  buyer_id:        string;          // 平台原生 buyer_id（用于反查订单）
  text:            string;
  attachments?:    Attachment[];
  raw:             unknown;         // 原始 payload，供 ledger 审计
  received_at:     string;          // ISO timestamp
}

export interface ReplyPayload {
  text:           string;
  quick_replies?: string[];
  meta?:          Record<string, unknown>;   // 例如 verdict / scope，供前端 debug
}

export interface SendResult {
  ok:           boolean;
  delivered_at: string;
  platform_id?: string;          // 平台返回的 message_id（如有）
  error?:       string;
}

export interface EscalationPayload {
  conversation_id:          string;
  user_original_complaint:  string;
  collected_verification:   Record<string, string>;
  verdict_trajectory:       unknown[];          // handoffContext.verdict_trajectory
  blocked_claims:           unknown[];
  raw_handoff_context?:     Record<string, unknown>;
}

export interface PlatformContext {
  conversation_id: string;
  buyer_id:        string;
  shop_id:         string;
  related_orders?: string[];
  raw?:            unknown;
}

export interface HealthStatus {
  ok:                boolean;
  platform:          Platform;
  token_valid?:      boolean;
  token_expires_at?: string;
  api_reachable?:    boolean;
  rate_limit_left?:  number;
  notes?:            string;
}

export interface ChannelCapabilities {
  text:         boolean;
  image_upload: boolean;
  voice:        boolean;
  file_upload:  boolean;
  /** 渠道是否能反查买家订单（基于 buyer_id） */
  buyer_order_lookup?: boolean;
}

export interface ChannelAdapter {
  readonly platform: Platform;
  readonly supported_capabilities: ChannelCapabilities;

  /** 启动时注册：平台推消息进来时如何处理 */
  onIncomingMessage(handler: (msg: NormalizedIncomingMessage) => Promise<void>): void;

  /** LIOS 推回复出去 */
  sendReply(conversationId: string, reply: ReplyPayload): Promise<SendResult>;

  /** 转人工：通知平台 + 打包上下文 */
  escalateToHuman(conversationId: string, context: EscalationPayload): Promise<void>;

  /** 平台元数据（可选）：拉取会话上下文（buyer_id、订单关联等） */
  fetchConversationContext?(conversationId: string): Promise<PlatformContext>;

  /** 健康检查（token 是否有效、API 是否可达） */
  healthCheck(): Promise<HealthStatus>;
}

export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotImplementedError';
  }
}
