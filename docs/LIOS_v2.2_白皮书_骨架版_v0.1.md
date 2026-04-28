# LIOS v2.2 平台化白皮书（骨架版）

**版本**: v0.1 骨架
**生成日期**: 2026-04-28
**完整版**: 待补（OI-δ-001）

---

## 1. 工程概览

LIOS v2.2 把单租户 v2.1 系统升级为多租户平台化系统。核心改造：

- **TenantPolicyRegistry**（可注入）：从函数式 `loadTenantPolicy()` 升级为 class with DI
- **lios_tenant_policies 治理策略表**：与 v2.1 lios_tenants 商户身份表物理分离
- **启动时从 DB 加载 tenant policy**：γ-1 临时硬编码彻底清除，registry 内容只来自 DB
- **LIOSAccessControl + 访问授权层**：preHandler 验 Bearer token + 跨租户 403 校验

战略锚点（交接书 §3）：
- 基础设施层：LIOS + 信息资产化系统（并列，互不消费）
- 产品应用层：标典 / 天问 / 问问 / City One，通过注册 `lios_tenants` + `lios_tenant_policies` 接入

---

## 2. Phase 划分与 commit 链

| Phase | Task | Commit | Tag |
|---|---|---|---|
| α | 拆分服务层（α-1..α-5+）| efff8e0 | v2.2-phase-α-complete (`ba887bb`) |
| β-1 | governance API via Fastify | 4c92d7c | |
| β-2 | 标准化错误处理 | 08282de | |
| β-3 | trace_id 跨系统关联 + lios_trace_links | 357fe16 | |
| β-5 | Phase β 收尾回归 | 7029e5e | v2.2-phase-β-complete |
| γ-1 | TenantPolicyRegistry 注入式 | 72d35dc | |
| γ-2 | lios_tenant_policies 表 | 5c4e034 | |
| γ-3 | 启动 DB 加载 + 临时硬编码清除 | be048e7 | |
| γ-4 | tianwen / biaodian 占位 + 文件重构 | 1c84630 | |
| γ-5 | LIOSAccessControl + token preHandler | 677733a | |
| γ-6 | 租户隔离测试沉淀 (v22 50/50) | 6a9d03e | |
| γ-7 | OI_REGISTRY + Phase γ 收尾 | ff35a74 | v2.2-phase-γ-complete |
| δ | 双路径回归 + 性能 + 白皮书骨架 + 终 tag | (本次) | v2.2-complete |

---

## 3. 战略锚点物理证据

### 3.1 龙码三层架构落地

- **基础设施层**：LIOS + 信息资产化（并列）
- **产品应用层**：标典 / 天问 / 问问 / City One
- **物理证据**：`lios_tenants`（v2.1 P1, 商户身份）+ `lios_tenant_policies`（γ-2 新建, 治理策略）双表分离, FK ON DELETE CASCADE

### 3.2 两套 token 边界

- **v2.1 lios_tenants.token**：商户登录令牌（身份认证，γ 阶段不动）
- **γ-5 lios_access_tokens.token**：LIOS API 访问授权令牌（绑定 tenant_id + source_app）
- **物理证据**：两表完全独立，UNIQUE (tenant_id, source_app) 一个商户多 source_app 多 token

### 3.3 γ-1 临时硬编码彻底清除

- γ-1 阶段 `LIOSGovernanceService.constructor` 内有 3 行 hardcoded `register('demo' / 'default' / 'healthcare-demo')`
- γ-3 完成后这 3 行物理消失，registry 内容只来自 DB
- **端到端验证**：tenant_id='default' / 'healthcare-demo' 调用报 `tenant not registered`（γ-3 commit be048e7 测过）；γ-5 后跨租户校验先于 service.decide 拦截 → 403（γ-5 commit 677733a 测过，γ-3 锚点物理保持）

---

## 4. 关键数据点

| 数据点 | 值 |
|---|---|
| 测试套件 v22（γ-6 后）| **50/50** (8 文件: bounds 4 + ext 6 + governance-api 11 + ledger 7 + service-stateless 5 + projection 7 + structured 5 + tenant-policy-registry 5) |
| 测试套件 mock LLM 22 case S1-S22 | **22/22** deterministic |
| 真实 LLM 22 case S1-S22（β-5 telemetry）| 20/22 (失败集合 {S12, S19} ⊂ α-3 已知波动) |
| DB 表数 | `lios_*` 共 19+ 张 |
| γ 阶段新增表 | 2 (`lios_tenant_policies` + `lios_access_tokens`) |
| γ 阶段新增迁移 | 3 (v12 + v13 + v14) |
| 启动时间（δ-2 实测，含 npm + tsx）| ~1046ms（loaded → ready 子段 < 100ms）|
| 单次 /lios/runtime/decide P50（δ-2 实测，10 runs）| 4322ms（含真实 LLM 4s, β-5 5iter overall 5324ms 对照 → -19% 略快）|
| DB 连接池稳态（δ-2 实测）| 2 connections（pool max=20，无泄漏）|
| 蓝图错误累计 | **20**（全部在落地前抓住，0 处真实问题）|

---

## 5. 蓝图错误简表（20 项）

α / 路径迁移阶段（错误 1-5）：
1. verifier 处理路径漏写（α-3 启动前）
2. ActionResolver 幂等查询边界（α-3 完成后）
3. "21/22" 当确定值写硬约束（α-3 测试时）
4. "失败 case 集合不同 = 退化"（α-5+ 时）
5. 路径搞错（系统文件 vs 系统代码，Mac 整理时）

β 阶段（错误 6-7）：
6. TokenManager 当 LIOS API 验证器（β-1 启动前）
7. SQL 迁移 + migrations/ 目录（β-3 启动前）

γ 阶段（错误 8-18）：
8. TenantPolicy 接口 11 字段（实 10）
9. v0.3 §γ-3 用 `db.query`（实 `query` 顶层 export）
10. v0.3 §γ-3 `new PolicyModule.default()`（实 const 实例非 class）
11. γ-2 INSERT 'healthcare' vs 真实 'healthcare-demo'
12. `policy_class` 字段名暗示 class（实 const）
13. v0.3 §γ-3 `db.query` 模块 (重复 #9, 调研复核登记)
14. v0.2 §γ-2 没看真 DB（lios_tenants 已存在 12 列）
15. γ-2 v0.1 `import from './index'`（实 `./client`）
16. γ-2 v0.1 `transaction()` 顶层 export（不存在）
17. γ-2 v0.1 `ts-node` runner（实 `tsx`）
18. γ-2 v0.1 `if (require.main === module)` 守卫（实顶层 `run()`）

γ-4 调研（错误 19-20）：
19. bounds_template 误以为有数值字段（实 3 个 string array）
20. Markdown 渲染陷阱（双下划线视觉失真，Claude Code 字符级 grep 拦下误判）

**全部在落地前抓住，0 处生产问题。** 详细复盘见各 commit message + `OI_REGISTRY.md`。

---

## 6. OI 留档

- **OI-γ-001**：HTTP 500 → 400 语义优化（registry.get throw 时）
- **OI-γ-002**：healthcare-demo 路径在当前数据下不可达
- **OI-δ-001**：本白皮书完整版待补
- 历史 OI-001 至 OI-010 见 `OI_REGISTRY.md` § 历史

---

## 7. 完整版需补（OI-δ-001）

骨架版省略以下内容，留完整版：

- 详细架构图（模块依赖 / 数据流 / 时序）
- 各 Phase 设计决策完整复盘（含未采纳候选）
- 蓝图错误 20 项分类与教训（认知漂移 vs 实情误判 vs 渲染陷阱）
- 性能基准详细数据（启动 / 单次 / 并发 / 长尾）
- 与 v2.1 对比的完整 diff（接口 / 表 / 行为）
- 资产化 P0 / 标典 P0 / 天问 P0 接入指南
- v2.2 → v2.3 演进路径（多区 / SLA / SDK / 后台）
