/**
 * Order Verifier 抽象层
 *
 * 同一套 LIOS preKernel 二次裁决逻辑，不同后端（Mock / Shopee Order API / Lazada Order API）
 * 实现同一接口。
 *
 * 关键设计：Channel 与 Verifier 解耦——
 *   即使是同一平台（如 Shopee），不同 App 类型授予的 API 不同
 *   （ERP App 没 Chat 但有 Order；Customer Service App 反之）。
 *   某些场景商户只想用 LIOS 做"订单核验"不接管聊天，或反之。
 */

export type OrderStatus =
  | 'unpaid'
  | 'to_ship'
  | 'shipped'
  | 'delivered'
  | 'returned'
  | 'cancelled';

export interface OrderItem {
  sku:   string;
  name:  string;
  qty:   number;
  price: number;       // 含税单价（货币单位由 OrderRecord.currency 决定）
}

export interface OrderRecord {
  order_id:               string;
  buyer_id:               string;
  items:                  OrderItem[];
  status:                 OrderStatus;
  purchased_at:           string;          // ISO timestamp
  total_amount:           number;
  currency:               string;          // ISO 4217（'TWD' / 'USD' / ...）
  return_eligible_until?: string;          // ISO timestamp，按平台政策算
}

export interface OrderSummary {
  order_id:     string;
  status:       OrderStatus;
  purchased_at: string;
  total_amount: number;
  currency:     string;
}

export type VerifyError =
  | 'not_found'
  | 'wrong_shop'
  | 'api_unavailable'
  | 'rate_limited';

export interface VerifyResult {
  exists:          boolean;
  belongs_to_shop: boolean;
  order?:          OrderRecord;
  error?:          VerifyError;
  /** 衍生标签，preKernel 二次裁决直接看：'exists_belongs_in_period' / 'exists_belongs_overdue' / 'wrong_shop' / 'returned' / 'shipping' / 'not_found' / 'api_unavailable' */
  classification:  string;
  latency_ms?:     number;
}

export interface VerifyContext {
  tenant_id: string;
  shop_id:   string;
  channel?:  'web_sdk' | 'shopee' | 'lazada' | 'tiktok_shop';
}

export type VerifierSource = 'mock' | 'shopee' | 'lazada' | 'tiktok_shop' | 'self_hosted';

export interface OrderVerifier {
  readonly source: VerifierSource;

  /** 通过订单号核验 */
  verifyByOrderId(orderId: string, ctx: VerifyContext): Promise<VerifyResult>;

  /**
   * 通过 buyer_id 反查订单（Shopee/Lazada 场景常用 — 平台会话本身就带 buyer_id，
   * 不需要用户主动给订单号）
   */
  listByBuyer(buyerId: string, ctx: VerifyContext): Promise<OrderSummary[]>;
}

/**
 * 把 VerifyResult 摘要成给 preKernel 看的"订单核验上下文"短文本
 */
export function summarizeVerification(result: VerifyResult): string {
  if (result.error === 'not_found') return 'order_lookup: not_found';
  if (result.error === 'api_unavailable') return 'order_lookup: api_unavailable';
  if (result.error === 'rate_limited') return 'order_lookup: rate_limited';
  if (!result.exists) return `order_lookup: ${result.classification}`;
  if (!result.belongs_to_shop) return 'order_lookup: wrong_shop';
  if (!result.order) return `order_lookup: ${result.classification}`;
  const o = result.order;
  const items = o.items.map(it => `${it.qty}x ${it.name}（${it.price} ${o.currency}）`).join('；');
  const elig  = o.return_eligible_until
    ? `退货截止：${o.return_eligible_until}`
    : '无退货截止信息';
  return `order_lookup: ${result.classification}; 订单${o.order_id}; 状态=${o.status}; ${items}; 总额=${o.total_amount} ${o.currency}; ${elig}`;
}
