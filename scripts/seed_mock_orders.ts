/**
 * Seed 5 mock orders 覆盖订单核验全部分类：
 *   100001  delivered     · return_eligible_until 未来   · 仍可退（exists_belongs_in_period）
 *   100002  delivered     · return_eligible_until 过去   · 已超退货期（exists_belongs_overdue）
 *   100003  returned                                         · 已退货（already_returned）
 *   100004  shipped                                          · 运输中（shipping）
 *   100005  delivered     · shop_id='other_shop'           · 不属本店（wrong_shop）
 *
 * 商品全部用 KB 中存在的「龍碼Pro智能手環 X9」，价格 NT$ 4,990
 */
import 'dotenv/config';
import { pool } from '../src/db/client';

const X9_ITEM = {
  sku:   'X9-AMOLED-50M',
  name:  '龍碼Pro智能手環 X9',
  qty:   1,
  price: 4990,
};

interface MockOrder {
  order_id:              string;
  tenant_id:             string;
  shop_id:               string;
  buyer_id:              string;
  items:                 typeof X9_ITEM[];
  status:                'delivered' | 'returned' | 'shipped';
  purchased_at:          string;
  total_amount:          number;
  currency:              string;
  return_eligible_until: string | null;
}

const now = new Date();
const futureDate = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
const pastDate   = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
const purchasedRecent  = new Date(now.getTime() - 5  * 24 * 60 * 60 * 1000);
const purchasedOld     = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
const purchasedShipped = new Date(now.getTime() - 1  * 24 * 60 * 60 * 1000);

const orders: MockOrder[] = [
  { order_id: '100001', tenant_id: 'demo', shop_id: 'demo',       buyer_id: 'buyer_a',
    items: [X9_ITEM], status: 'delivered',
    purchased_at: purchasedRecent.toISOString(), total_amount: 4990, currency: 'TWD',
    return_eligible_until: futureDate.toISOString() },
  { order_id: '100002', tenant_id: 'demo', shop_id: 'demo',       buyer_id: 'buyer_b',
    items: [X9_ITEM], status: 'delivered',
    purchased_at: purchasedOld.toISOString(),    total_amount: 4990, currency: 'TWD',
    return_eligible_until: pastDate.toISOString() },
  { order_id: '100003', tenant_id: 'demo', shop_id: 'demo',       buyer_id: 'buyer_c',
    items: [X9_ITEM], status: 'returned',
    purchased_at: purchasedRecent.toISOString(), total_amount: 4990, currency: 'TWD',
    return_eligible_until: futureDate.toISOString() },
  { order_id: '100004', tenant_id: 'demo', shop_id: 'demo',       buyer_id: 'buyer_d',
    items: [X9_ITEM], status: 'shipped',
    purchased_at: purchasedShipped.toISOString(), total_amount: 4990, currency: 'TWD',
    return_eligible_until: null },
  { order_id: '100005', tenant_id: 'demo', shop_id: 'other_shop', buyer_id: 'buyer_e',
    items: [X9_ITEM], status: 'delivered',
    purchased_at: purchasedRecent.toISOString(), total_amount: 4990, currency: 'TWD',
    return_eligible_until: futureDate.toISOString() },
];

async function main() {
  const c = await pool.connect();
  try {
    for (const o of orders) {
      await c.query(
        `INSERT INTO mock_orders
           (order_id, tenant_id, shop_id, buyer_id, items, status,
            purchased_at, total_amount, currency, return_eligible_until, raw)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$5::jsonb)
         ON CONFLICT (order_id) DO UPDATE SET
           tenant_id=EXCLUDED.tenant_id,
           shop_id=EXCLUDED.shop_id,
           buyer_id=EXCLUDED.buyer_id,
           items=EXCLUDED.items,
           status=EXCLUDED.status,
           purchased_at=EXCLUDED.purchased_at,
           total_amount=EXCLUDED.total_amount,
           currency=EXCLUDED.currency,
           return_eligible_until=EXCLUDED.return_eligible_until,
           updated_at=now()`,
        [
          o.order_id, o.tenant_id, o.shop_id, o.buyer_id,
          JSON.stringify(o.items), o.status,
          o.purchased_at, o.total_amount, o.currency, o.return_eligible_until,
        ],
      );
      console.log(`  + ${o.order_id} (${o.status}, shop=${o.shop_id})`);
    }
    console.log(`✅ seeded ${orders.length} mock orders`);
  } finally {
    c.release();
    await pool.end();
  }
}

main().catch(err => { console.error(err); process.exitCode = 1; });
