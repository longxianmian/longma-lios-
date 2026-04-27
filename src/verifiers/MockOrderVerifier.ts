/**
 * MockOrderVerifier — 连本地 PostgreSQL mock_orders 表
 *
 * 实现 OrderVerifier 契约。生产环境会被 ShopeeOrderVerifier / LazadaOrderVerifier 替换。
 *
 * 衍生 classification 规则（preKernel 二次裁决直接看）：
 *   - 不存在                                    → not_found
 *   - 存在但 shop_id 不匹配                      → wrong_shop
 *   - 存在 + 本店 + status=returned             → already_returned
 *   - 存在 + 本店 + status in (shipped, to_ship) → shipping
 *   - 存在 + 本店 + status=delivered + 退货期内  → exists_belongs_in_period
 *   - 存在 + 本店 + status=delivered + 退货期过  → exists_belongs_overdue
 *   - 其他/异常                                  → api_unavailable
 */

import { query } from '../db/client';
import {
  OrderVerifier, VerifierSource, VerifyContext, VerifyResult, OrderRecord, OrderItem, OrderSummary,
} from './types';

interface DBRow {
  order_id:              string;
  tenant_id:             string;
  shop_id:               string;
  buyer_id:              string;
  items:                 OrderItem[];
  status:                OrderRecord['status'];
  purchased_at:          string;
  total_amount:          string | number;
  currency:              string;
  return_eligible_until: string | null;
}

function parseRow(r: DBRow): OrderRecord {
  return {
    order_id:              r.order_id,
    buyer_id:              r.buyer_id,
    items:                 Array.isArray(r.items) ? r.items : (typeof r.items === 'string' ? JSON.parse(r.items) : []),
    status:                r.status,
    purchased_at:          new Date(r.purchased_at).toISOString(),
    total_amount:          Number(r.total_amount),
    currency:              r.currency,
    return_eligible_until: r.return_eligible_until ? new Date(r.return_eligible_until).toISOString() : undefined,
  };
}

function classify(order: OrderRecord, ctx: VerifyContext, dbShopId: string): { exists: boolean; belongs_to_shop: boolean; classification: string } {
  const belongs = dbShopId === ctx.shop_id;
  if (!belongs) return { exists: true, belongs_to_shop: false, classification: 'wrong_shop' };
  if (order.status === 'returned')   return { exists: true, belongs_to_shop: true, classification: 'already_returned' };
  if (order.status === 'shipped' || order.status === 'to_ship') return { exists: true, belongs_to_shop: true, classification: 'shipping' };
  if (order.status === 'cancelled')  return { exists: true, belongs_to_shop: true, classification: 'cancelled' };
  if (order.status === 'delivered') {
    const elig = order.return_eligible_until ? new Date(order.return_eligible_until).getTime() : 0;
    if (elig && elig >= Date.now()) return { exists: true, belongs_to_shop: true, classification: 'exists_belongs_in_period' };
    return { exists: true, belongs_to_shop: true, classification: 'exists_belongs_overdue' };
  }
  // unpaid 等其他状态
  return { exists: true, belongs_to_shop: true, classification: 'other_status' };
}

export class MockOrderVerifier implements OrderVerifier {
  readonly source: VerifierSource = 'mock';

  async verifyByOrderId(orderId: string, ctx: VerifyContext): Promise<VerifyResult> {
    const t0 = Date.now();
    const id = (orderId ?? '').trim();
    if (!id) {
      return { exists: false, belongs_to_shop: false, error: 'not_found', classification: 'not_found', latency_ms: Date.now() - t0 };
    }

    let rows: DBRow[];
    try {
      rows = await query<DBRow>(
        `SELECT order_id, tenant_id, shop_id, buyer_id, items, status,
                purchased_at, total_amount, currency, return_eligible_until
           FROM mock_orders
          WHERE order_id = $1 AND tenant_id = $2`,
        [id, ctx.tenant_id],
      );
    } catch (err) {
      return { exists: false, belongs_to_shop: false, error: 'api_unavailable', classification: 'api_unavailable', latency_ms: Date.now() - t0 };
    }

    if (rows.length === 0) {
      return { exists: false, belongs_to_shop: false, error: 'not_found', classification: 'not_found', latency_ms: Date.now() - t0 };
    }

    const row = rows[0];
    const order = parseRow(row);
    const c = classify(order, ctx, row.shop_id);

    return {
      exists:          c.exists,
      belongs_to_shop: c.belongs_to_shop,
      order:           c.belongs_to_shop ? order : undefined,
      classification:  c.classification,
      error:           c.belongs_to_shop ? undefined : 'wrong_shop',
      latency_ms:      Date.now() - t0,
    };
  }

  async listByBuyer(buyerId: string, ctx: VerifyContext): Promise<OrderSummary[]> {
    const rows = await query<DBRow>(
      `SELECT order_id, tenant_id, shop_id, buyer_id, items, status,
              purchased_at, total_amount, currency, return_eligible_until
         FROM mock_orders
        WHERE tenant_id = $1 AND shop_id = $2 AND buyer_id = $3
        ORDER BY purchased_at DESC LIMIT 20`,
      [ctx.tenant_id, ctx.shop_id, buyerId],
    ).catch(() => []);
    return rows.map(r => ({
      order_id:     r.order_id,
      status:       r.status,
      purchased_at: new Date(r.purchased_at).toISOString(),
      total_amount: Number(r.total_amount),
      currency:     r.currency,
    }));
  }
}

export const mockOrderVerifier = new MockOrderVerifier();
