/**
 * v14 — lios_access_tokens 表（v2.2 Phase γ-5）
 *
 * 战略锚点：
 *   LIOS API 访问授权层。给 /lios/runtime/decide 加一道 token 验证 middleware,
 *   token 绑定 (tenant_id, source_app)，确保产品应用调 LIOS API 时必须带合法 token。
 *
 * 两套 token 边界（γ-2 commit 已固化, γ-5 落地实现）：
 *   1. v2.1 lios_tenants.token       — 商户登录令牌（身份认证, γ 阶段不动）
 *   2. γ-5 lios_access_tokens.token  — LIOS API 访问授权令牌（本次新建）
 *      绑定: (tenant_id, source_app)
 *      一个 tenant 可有多个 token（天问/标典/问问 各一个）
 *   两套 token 完全独立，不互通。
 *
 * 字段：
 *   token       TEXT PRIMARY KEY      — token 字符串本身（生产 token 由后台真实生成）
 *   tenant_id   TEXT NOT NULL REFERENCES lios_tenants(tenant_id) ON DELETE CASCADE
 *   source_app  TEXT NOT NULL         — 'tianwen' / 'biaodian' / 'demo' 等产品应用标识
 *   is_active   BOOLEAN NOT NULL DEFAULT true
 *   created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
 *   updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
 *
 * 约束：
 *   UNIQUE (tenant_id, source_app) — 一个 tenant 在一个 source_app 上只能有一个活跃 token
 *
 * 索引：
 *   idx_lios_access_tokens_tenant (tenant_id) — 按租户查 token 列表
 *
 * 种子数据（3 行测试 token, for γ-4 创建的 3 个 tenant 各发一个）：
 *   ('lios_test_token_demo_v22',          'demo',          'demo')
 *   ('lios_test_token_tianwen_demo_v22',  'tianwen-demo',  'tianwen')
 *   ('lios_test_token_biaodian_demo_v22', 'biaodian-demo', 'biaodian')
 *
 *   注：种子 token 字符串明显标 'test' + 'v22'，绝不可能误认为生产 token。
 *   生产 token 由后台管理系统真实生成（γ-5 不实现后台，只实现 token 验证）。
 *
 * 回滚：见 migrate_v14_down.ts
 */

import 'dotenv/config';
import { pool } from './client';

const DDL_V14 = `
CREATE TABLE IF NOT EXISTS lios_access_tokens (
  token       TEXT        PRIMARY KEY,
  tenant_id   TEXT        NOT NULL
                REFERENCES lios_tenants(tenant_id) ON DELETE CASCADE,
  source_app  TEXT        NOT NULL,
  is_active   BOOLEAN     NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, source_app)
);

CREATE INDEX IF NOT EXISTS idx_lios_access_tokens_tenant
  ON lios_access_tokens (tenant_id);
`;

const SEED_V14 = `
INSERT INTO lios_access_tokens (token, tenant_id, source_app) VALUES
  ('lios_test_token_demo_v22',          'demo',          'demo'),
  ('lios_test_token_tianwen_demo_v22',  'tianwen-demo',  'tianwen'),
  ('lios_test_token_biaodian_demo_v22', 'biaodian-demo', 'biaodian')
ON CONFLICT (token) DO NOTHING;
`;

async function run() {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(DDL_V14);
    await c.query(SEED_V14);
    await c.query('COMMIT');
    console.log('✅ migrate_v14 done — lios_access_tokens (3 test tokens seeded)');
  } catch (e) {
    await c.query('ROLLBACK');
    console.error('❌ migrate_v14 failed:', e);
    process.exitCode = 1;
  } finally {
    c.release();
    await pool.end();
  }
}

run();
