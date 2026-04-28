/**
 * v13 — tianwen-demo + biaodian-demo 占位 tenant + policy（v2.2 Phase γ-4）
 *
 * 战略锚点：
 *   注册 'tianwen-demo' + 'biaodian-demo' 两个产品应用占位 tenant，
 *   配合 γ-4 创建的 TianwenPolicy / BiaodianPolicy 占位骨架走通 LIOS 全链路。
 *   这是 γ-3 "DB → registry → service" 机制对真实产品应用 tenant 工作的第一遍验证。
 *
 * 龙码三层架构（DB 层物理表达）：
 *   - 基础设施层：LIOS + 信息资产化系统（并列，互不消费）
 *   - 产品应用层：标典 / 天问 / 问问 / City One
 *   未来天问 / 标典 SaaS 真正启动时，通过 migrate_v14+ 把占位换成真实业务规则，
 *   不需要再改 LIOS 内核。
 *
 * 设计决议（用户拍）：
 *   - Q4 (a)：占位身份明确风格 — email '@longma-placeholder.local',
 *             password_hash '__not_for_login__', token '__not_for_login__',
 *             company_name '[占位]' 前缀；确保未来不被误用为真实账号
 *   - Q5 (a)：TenantPolicy 占位骨架（详见 src/policy/policies/{tianwen,biaodian}.ts）
 *   - #E (ii)：文件结构完整拆分 src/policy/policies/{4 file}.ts + index.ts
 *
 * 两套 token 边界（γ-5 必须遵守）：
 *   1. v2.1 lios_tenants.token       — 商户登录令牌（身份认证, 后台管理系统登录）
 *                                       绑定 (email + password_hash) → token
 *                                       γ 阶段不动；占位 tenant 用 '__not_for_login__'
 *                                       明示不可登录
 *   2. γ-5 LIOSAccessControl token   — LIOS API 访问授权令牌（产品应用调
 *                                       /lios/runtime/decide）
 *                                       绑定 (tenant_id, source_app) → token
 *                                       存 lios_access_tokens 表（γ-5 新建，非本次）
 *   两套 token 完全独立，不互通。
 *
 * INSERT 顺序：先 lios_tenants 再 lios_tenant_policies（外键依赖：
 *   lios_tenant_policies.tenant_id REFERENCES lios_tenants(tenant_id) ON DELETE CASCADE）。
 *
 * 不变更：
 *   - 'demo' 商户身份和 policy 数据完全不变（γ-3 战略锚点保持）
 *   - v2.1 lios_tenants 表结构（含 12 列 + 6 索引 + status check constraint）
 *   - γ-1/γ-2/γ-3 已有代码逻辑
 *
 * 回滚：见 migrate_v13_down.ts
 */

import 'dotenv/config';
import { pool } from './client';

const INSERT_TENANTS_V13 = `
INSERT INTO lios_tenants
  (tenant_id, company_name, contact_name, email, password_hash, industry, company_size, token)
VALUES
  ('tianwen-demo',  '[占位] 天问 ToC Agent',     '占位',
   'tianwen-demo@longma-placeholder.local',  '__not_for_login__',
   '', '', '__not_for_login__'),
  ('biaodian-demo', '[占位] 标典招投标助手',     '占位',
   'biaodian-demo@longma-placeholder.local', '__not_for_login__',
   '', '', '__not_for_login__')
ON CONFLICT (tenant_id) DO NOTHING;
`;

const INSERT_POLICIES_V13 = `
INSERT INTO lios_tenant_policies (tenant_id, policy_id) VALUES
  ('tianwen-demo',  'tianwen'),
  ('biaodian-demo', 'biaodian')
ON CONFLICT (tenant_id) DO NOTHING;
`;

async function run() {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    // 顺序: 先 lios_tenants 再 lios_tenant_policies (外键依赖)
    await c.query(INSERT_TENANTS_V13);
    await c.query(INSERT_POLICIES_V13);
    await c.query('COMMIT');
    console.log('✅ migrate_v13 done — tianwen-demo + biaodian-demo (lios_tenants + lios_tenant_policies)');
  } catch (e) {
    await c.query('ROLLBACK');
    console.error('❌ migrate_v13 failed:', e);
    process.exitCode = 1;
  } finally {
    c.release();
    await pool.end();
  }
}

run();
