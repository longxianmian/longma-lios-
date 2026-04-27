/**
 * v8 — mock_orders 表（订单核验后端，对齐 Shopee/Lazada 字段抽象）
 *
 * Phase 1 用本表给 MockOrderVerifier 当后端，验证治理架构在订单核验场景下可用。
 * Phase 2+ 接 ShopeeOrderVerifier / LazadaOrderVerifier 时，本表保留作为开发/测试沙箱。
 */

import 'dotenv/config';
import { pool } from './client';

async function run() {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');

    await c.query(`
      CREATE TABLE IF NOT EXISTS mock_orders (
        order_id              text PRIMARY KEY,
        tenant_id             text NOT NULL,
        shop_id               text NOT NULL,
        buyer_id              text NOT NULL,
        items                 jsonb NOT NULL,
        status                text NOT NULL CHECK (status IN ('unpaid','to_ship','shipped','delivered','returned','cancelled')),
        purchased_at          timestamptz NOT NULL,
        total_amount          numeric(14,2) NOT NULL,
        currency              text NOT NULL DEFAULT 'TWD',
        return_eligible_until timestamptz,
        raw                   jsonb,
        created_at            timestamptz NOT NULL DEFAULT now(),
        updated_at            timestamptz NOT NULL DEFAULT now()
      );
    `);

    await c.query(`
      CREATE INDEX IF NOT EXISTS idx_mock_orders_tenant_shop_buyer
        ON mock_orders (tenant_id, shop_id, buyer_id);
    `);
    await c.query(`
      CREATE INDEX IF NOT EXISTS idx_mock_orders_status
        ON mock_orders (status);
    `);

    await c.query('COMMIT');
    console.log('✅ migrate_v8 done — mock_orders');
  } catch (e) {
    await c.query('ROLLBACK');
    console.error('❌ migrate_v8 failed:', e);
    process.exitCode = 1;
  } finally {
    c.release();
    await pool.end();
  }
}

run();
