/**
 * Lazada Order Verifier — Phase 1 占位
 *
 * 真实接入参考（参方案文档）：
 *   - 平台：https://open.lazada.com/
 *   - 认证：App Key + App Secret + access_token（每 6 个月强制重授权）
 *   - 多市场：SG/TH/MY/VN/PH/ID 六国，每市场独立授权与 endpoint
 *   - 关键 API：
 *       GET /order/get   — 单订单查询
 *       GET /orders/get  — 订单列表（按 created_after 等过滤）
 *
 * 真实实现关键步骤：
 *   1. TokenManager.getCredentials(tenant_id, 'lazada', market) 拿 app_secret + access_token
 *   2. 按 market 选 endpoint host（如 https://api.lazada.sg/rest/order/get）
 *   3. 签名：sha256_hmac(app_secret, sortedParamsJoinedWithKeysAndValues)
 *   4. 把 Lazada 响应映射成 OrderRecord：
 *        statuses: pending / ready_to_ship / shipped / delivered / canceled / returned
 *        return_eligible_until 按 Lazada 各市场政策计算（部分市场无固定窗口）
 */

import {
  OrderVerifier, VerifierSource, VerifyContext, VerifyResult, OrderSummary,
} from './types';
import { NotImplementedError } from '../channels/types';

export class LazadaOrderVerifier implements OrderVerifier {
  readonly source: VerifierSource = 'lazada';

  async verifyByOrderId(_orderId: string, _ctx: VerifyContext): Promise<VerifyResult> {
    throw new NotImplementedError('LazadaOrderVerifier.verifyByOrderId not implemented in this phase (target: GET /order/get)');
  }

  async listByBuyer(_buyerId: string, _ctx: VerifyContext): Promise<OrderSummary[]> {
    throw new NotImplementedError('LazadaOrderVerifier.listByBuyer not implemented in this phase (target: GET /orders/get with buyer filter)');
  }
}
