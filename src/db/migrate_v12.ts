/**
 * v12 — lios_tenant_policies 表（v2.2 Phase γ-2）
 *
 * 治理策略表：与 v2.1 lios_tenants 物理分离，外键引用 (ON DELETE CASCADE)。
 *
 * 龙码三层架构（DB 层物理表达）：
 *   - 基础设施层：LIOS + 信息资产化系统（并列，互不消费）
 *   - 产品应用层：标典 / 天问 / 问问 / City One
 *   只有产品应用注册 lios_tenants + lios_tenant_policies。资产化系统不走此流程。
 *   先有商户身份（lios_tenants）才能挂治理策略（lios_tenant_policies）。
 *
 * 两套 token 边界（γ-5 必须遵守）：
 *   1. v2.1 lios_tenants.token       — 商户登录令牌（身份认证, 后台管理系统登录）
 *                                       绑定 (email + password_hash) → token；γ 阶段不动
 *   2. γ-5 LIOSAccessControl token   — LIOS API 访问授权令牌（产品应用调
 *                                       /lios/runtime/decide）
 *                                       绑定 (tenant_id, source_app) → token
 *                                       存 lios_access_tokens 表（γ-5 新建，非本次）
 *   两套 token 完全独立，不互通。
 *
 * 字段：
 *   tenant_id   TEXT PRIMARY KEY REFERENCES lios_tenants(tenant_id) ON DELETE CASCADE
 *   policy_id   TEXT NOT NULL                          — 与 TenantPolicy.industry 对齐
 *   is_active   BOOLEAN NOT NULL DEFAULT true
 *   created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
 *   updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
 *
 * 种子数据（按 Q1 决议）：
 *   ('demo', 'electric_commerce')
 *   不插 'default'（Q2 决议：γ-1 missing → throw 已锁，'default' 兜底逻辑不自洽）
 *   不插 'healthcare-demo'（Q1 决议：v2.1 lios_tenants 未注册该商户，留 γ-4 决定）
 *
 * 回滚：见 migrate_v12_down.ts
 */

import 'dotenv/config';
import { pool } from './client';

const DDL_V12 = `
CREATE TABLE IF NOT EXISTS lios_tenant_policies (
  tenant_id  TEXT        PRIMARY KEY
              REFERENCES lios_tenants(tenant_id) ON DELETE CASCADE,
  policy_id  TEXT        NOT NULL,
  is_active  BOOLEAN     NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

const SEED_V12 = `
INSERT INTO lios_tenant_policies (tenant_id, policy_id) VALUES
  ('demo', 'electric_commerce')
ON CONFLICT (tenant_id) DO NOTHING;
`;

async function run() {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(DDL_V12);
    await c.query(SEED_V12);
    await c.query('COMMIT');
    console.log('✅ migrate_v12 done — lios_tenant_policies');
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
