/**
 * v12 — lios_tenants 表（v2.2 Phase γ-2）
 *
 * 多租户机制 schema 落地：γ-3 启动时从此表加载 tenants 注册到 TenantPolicyRegistry，
 * γ-5 lios_access_tokens 外键引用 tenant_id。
 *
 * 字段（按 γ-2 决议精简版）：
 *   tenant_id    TEXT PRIMARY KEY      — 与 TenantPolicy.tenant_id 对齐
 *   display_name TEXT NOT NULL         — 后台 dashboard 展示用
 *   policy_id    TEXT NOT NULL         — 与 TenantPolicy.industry 对齐（γ-3 用 map
 *                                        把 'electric_commerce' / 'healthcare' 等
 *                                        解析为 const policy 实例；解耦 schema
 *                                        字段值与代码符号名）
 *   is_active    BOOLEAN DEFAULT true
 *   created_at   TIMESTAMPTZ DEFAULT now()
 *   updated_at   TIMESTAMPTZ DEFAULT now()
 *
 * 默认数据：3 行（与 γ-1 LIOSGovernanceService.constructor 注册的 registry 对齐）
 *   demo            → electric_commerce
 *   default         → electric_commerce
 *   healthcare-demo → healthcare
 *
 * 蓝图修订:
 *   - v0.2 §γ-2 字段名 policy_class 暗示 class，但 γ-1 已确认 policy 是 const
 *     实例非 class；本 commit 用 policy_id 抽象化，γ-3 用 map 解析
 *   - v0.2 §γ-2 INSERT 'healthcare' 与 γ-1 真实 policy.tenant_id='healthcare-demo'
 *     不一致；本 commit 用 'healthcare-demo' 对齐
 *   - v0.2 §γ-2 还有 lios_tenant_tokens 表，已被 v0.3 §2.3 改名 lios_access_tokens
 *     并归 γ-5；本 commit 不建 token 表
 *
 * 回滚：见 migrate_v12_down.ts
 */

import 'dotenv/config';
import { pool } from './client';

const DDL_V12 = `
CREATE TABLE IF NOT EXISTS lios_tenants (
  tenant_id    TEXT        PRIMARY KEY,
  display_name TEXT        NOT NULL,
  policy_id    TEXT        NOT NULL,
  is_active    BOOLEAN     NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lios_tenants_active
  ON lios_tenants (is_active) WHERE is_active = true;

INSERT INTO lios_tenants (tenant_id, display_name, policy_id) VALUES
  ('demo',            'Demo Electric Commerce', 'electric_commerce'),
  ('default',         'Default Tenant',         'electric_commerce'),
  ('healthcare-demo', 'Healthcare Consult',     'healthcare')
ON CONFLICT (tenant_id) DO NOTHING;
`;

async function run() {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(DDL_V12);
    await c.query('COMMIT');
    console.log('✅ migrate_v12 done — lios_tenants');
  } catch (e) {
    await c.query('ROLLBACK');
    console.error('❌ migrate_v12 failed:', e);
    process.exitCode = 1;
  } finally {
    c.release();
    await pool.end();
  }
}

run();
