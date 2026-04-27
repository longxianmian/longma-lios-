/**
 * Shopee Order Verifier — Phase 1 占位
 *
 * 真实接入参考（参方案文档）：
 *   - API：partner.shopeemobile.com/api/v2/order/get_order_detail
 *   - 认证：Partner ID + Partner Key + access_token + HMAC-SHA256 签名
 *   - 与 ShopeeChannelAdapter 解耦——某些 ERP App 没有 Chat 但有 Order 权限
 *
 * 真实实现关键步骤：
 *   1. TokenManager.getCredentials(tenant_id, 'shopee') 拿 partner_key + access_token
 *   2. 计算 sign = HMAC-SHA256(partner_key, partner_id + path + ts + access_token + shop_id)
 *   3. GET /api/v2/order/get_order_detail?order_sn_list=...&fields=...
 *   4. 把 Shopee 响应的 order_status, item_list, ship_by_date 映射成 OrderRecord
 *      映射表（节选）：
 *        Shopee READY_TO_SHIP / SHIPPED → 'shipped'
 *        Shopee COMPLETED               → 'delivered'
 *        Shopee CANCELLED               → 'cancelled'
 *        return_eligible_until          → ship_by_date + return_window（按 Shopee 政策算）
 */

import {
  OrderVerifier, VerifierSource, VerifyContext, VerifyResult, OrderSummary,
} from './types';
import { NotImplementedError } from '../channels/types';

export class ShopeeOrderVerifier implements OrderVerifier {
  readonly source: VerifierSource = 'shopee';

  async verifyByOrderId(_orderId: string, _ctx: VerifyContext): Promise<VerifyResult> {
    throw new NotImplementedError('ShopeeOrderVerifier.verifyByOrderId not implemented in this phase (target: GET /api/v2/order/get_order_detail)');
  }

  async listByBuyer(_buyerId: string, _ctx: VerifyContext): Promise<OrderSummary[]> {
    throw new NotImplementedError('ShopeeOrderVerifier.listByBuyer not implemented in this phase (target: GET /api/v2/order/get_order_list with filter)');
  }
}
