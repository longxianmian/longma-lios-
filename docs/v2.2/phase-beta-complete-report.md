# LIOS v2.2 Phase β 完整交付报告

**版本**：1.0
**日期**：2026-04-28
**分支**：`v2.2-platformization`
**前置 tag**：`v2.2-phase-α-complete` (`ba887bb`)
**面向**：v2.2 Phase γ 启动前必读

---

## 0. 摘要

| 项 | 值 |
|---|---|
| Phase β 启动 | 2026-04-28 上午（紧接 α-5+ 完成后路径迁移 + β 启动）|
| Phase β 完成 | 2026-04-28 晚 |
| 工期 | ~1 天 |
| Task 数 | 4（β-1 / β-2 / β-3 / β-5；β-4 已并入 β-5，按 v0.3 §1.6） |
| 退化锚点 | **v22 41/41 + mock LLM 22/22 + 真实 LLM 20/22 (telemetry)** |
| 远程 tag | `v2.2-phase-β-complete`（用户授权后打）|

---

## 1. 4 个 task 完成清单

| Task | Commit | 内容 | 验收 |
|---|---|---|---|
| β-1 | `4c92d7c` | `src/api/governance.ts` Fastify 路由暴露 `LIOSGovernanceService.decide()`；按候选 A 决议**不引入 token 验证**（v2.1 路由惯例：body.tenant_id 模式；token 体系延后到 γ-5）；`trace_id` 用 `randomUUID()` 就地生成 | T1-T3 全过 + e2e curl 真实 LLM verdict=accept ✅ |
| β-2 | `08282de` | `src/api/errors.ts` 4 个错误码（E_REQ_001 / E_KERNEL_001 / E_TIMEOUT_001 / E_INTERNAL，全部可触发，不只是常量）；`withTimeout` 30s（env 可调）；`app.setErrorHandler` 在 governance plugin scope 兜底，不污染其他路由 | T1-T5 全过 ✅ |
| β-3 | `357fe16` | `src/db/migrate_v11.ts` + `migrate_v11_down.ts`（按 v2.1 TS 模式，**不引入蓝图原 SQL 模式**）；`lios_trace_links` 表 5 列 + 2 索引；`governance.ts` 加 `writeTraceLink` fire-and-forget 异步写；测试钩子 `__setWriteTraceLinkForTest` | T1-T7 全过 + e2e DB 1 row 验证 ✅ |
| β-5 | (本 commit) | Phase β 收尾回归 + 双 benchmark + 真实 LLM 22 case telemetry + 报告落档 | 见 §3 / §4 |

---

## 2. β-3 5 问决议记录

启动 β-3 前用户裁决的 5 个方向问题：

| Q | 决议 | 落地 |
|---|---|---|
| Q1 | 不建 `src/core/tracing.ts` | governance.ts 直接 `import { randomUUID } from 'crypto'` |
| Q2 | trace_id 用标准 UUID v4，不加前缀 | `randomUUID()`，丢弃蓝图原 `lios_trace_${uuid8}_${Date.now()}` 设计 |
| Q3 | 候选 A：`src/db/migrate_v11.ts` TS 模式（顺 v2.1 已有 10 个迁移惯例）| 同时落 down 脚本对称，`package.json` 加 `migrate:v11{,down}` |
| Q4 | source_app DEFAULT 'unknown'，β 阶段不强校验 | schema NOT NULL DEFAULT + governance.ts fallback `'unknown'` |
| Q5 | trace_link 异步写（fire-and-forget）+ 失败不影响主流程 | `void writeTraceLinkImpl(...).catch(warn)`；T6/T7 双重测试覆盖 |

---

## 3. 退化锚点（按 OI-009 双锚点 + 真实 LLM telemetry）

| 锚点 | 文件 | 通过条件 | β-5 实测 |
|---|---|---|---|
| v22 验收测试集 | `tests/v22/*.test.ts` (7 文件) | 全过 | **41/41 ✅** (β-3 把 governance-api 从 5 → 7) |
| Mock LLM 22 case (S1-S22) | `tests/adversarial/runner-with-mock-llm.ts` | 22/22 deterministic | **22/22 ✅** |
| 真实 LLM 22 case (S1-S22) | `tests/adversarial/runner.cjs` | 19-21/22 正常区间 | **20/22 ✅** (失败 {S12, S19}, 154s) |

真实 LLM 失败集合 {S12, S19} ⊂ α-3 5 跑失败集合 {S12, S15, S19}，是 α-3 已知 stochastic 波动子集，**非 β 引入**。

---

## 4. Phase β 性能基准

**工程证据**：Phase β 对 chat 路径 0 改动。`git diff efff8e0..HEAD` 在 `src/runtime/ src/service/ src/kernel/ src/generator/ src/auditor/ src/extractor/ src/binder/ src/builder/ src/resolver/` 上 **0 字节差异**。β 阶段代码增量 504 行全部在新路径 `src/api/governance.ts` (136) + `src/api/errors.ts` (53) + `src/db/migrate_v11{,_down}.ts` (87) + 测试 (224) + `index.ts` 注册 (2) + `package.json` (2)。

**测量数据 (5 iter)**：

| 路径 | overall avg | 对比基准 | 变化 |
|---|---|---|---|
| chat (`/lios/chat`) | 4996ms | α-3 baseline 3794ms | +31.7% |
| governance (`/lios/runtime/decide`) | 5324ms | chat | +6.6% |

落档：`docs/v2.2/benchmark-beta-chat-5iter.txt` + `docs/v2.2/benchmark-beta-governance-5iter.txt`。

**性能解读**：
- 数据存在明显波动：chat kb_x9_price max=9932ms、governance compound max=10956ms 接近 10s，α-3 时段未出现此量级 outlier
- chat / governance 两条路径 median 互有快慢（kb_x9_price governance 比 chat 反而快 21.4%；compound 近似），无系统性新路径开销
- 退化主要来自 OpenAI API 当前时段长尾延迟

**退化判断**：按 OI-009 双锚点 + 工程证据：
- v22 41/41 ✅
- mock LLM 22/22 ✅
- 真实 LLM 20/22（telemetry）失败集合 ⊂ α-3 已知波动 ✅
- chat 路径代码 0 改动（git 证据）

**结论**：Phase β 工程上未引入退化。OpenAI 端长尾波动属外部因素。**`docs/v2.2/benchmark-beta-governance-5iter.txt` 作为 γ 阶段对比基线**——γ 阶段完成后跑同脚本对比：若 γ 也漂浮则 LLM 端噪音；若 γ 稳定退化某量则 γ 真引入开销。

---

## 5. 蓝图层错误复盘（第 6 + 第 7 次）

### 错误 6 · TokenManager 当 LIOS API 验证器（β-1 启动前）

- 蓝图 §β-1 写 `import { TokenManager } from '../auth/TokenManager'; new TokenManager(); tokenManager.validateTenantToken(token)`
- 实情：TokenManager 是 v2.1 为 **Shopee/Lazada 商家平台凭证**设的 interface（getCredentials/refresh/upsert/notifyExpiringSoon），`validateTenantToken` 根本不存在；`new` interface 也不合法
- v2.1 路由惯例（assets/agent/decisions/plugins/chat/tenants 共 6 条）全部 body.tenant_id 模式，0 条用 token
- Claude Code 在 β-1 启动前 grep 发现 → 用户决议候选 A：β 阶段不引入 token，γ-5 新建 `LIOSAccessControl`（独立类，不染指 TokenManager）

### 错误 7 · SQL 迁移 + migrations/ 目录（β-3 启动前）

- 蓝图 §β-3 写 `migrations/v11_trace_links.sql` + 暗示某种 generic SQL runner
- 实情：v2.1 真实迁移机制是 `src/db/migrate_v{N}.ts`（TypeScript），通过 `npm run migrate:vN` 调用；已有 10 个 migrate 文件（v1-v10）；幂等用 `CREATE TABLE IF NOT EXISTS`；`migrations/` 目录是 α-1 创建的占位（`.gitkeep`），从未放过文件
- Claude Code 在 β-3 启动前调研 migration runner 真实情况 → 用户决议候选 A：顺 v2.1 惯例 `src/db/migrate_v11.ts`；蓝图 v0.3.1 修订承认错误

### 共性

错误 1-5 见 `phase-alpha-complete-report.md` §8。共性：**没看真代码就凭印象写蓝图**。Phase β 4 个 task 中 2 个（β-1 + β-3）启动前因 grep 真实接口而停下汇报，全部由用户裁决候选后才启动。

---

## 6. Phase γ 启动条件清单

按蓝图 v0.3 + v0.3.1，Phase γ 启动需要：

- [x] β-1 / β-2 / β-3 / β-5 全部 commit + push 到 origin
- [x] v22 锚点 41/41
- [x] Mock LLM 22 case S1-S22 22/22
- [x] 真实 LLM telemetry 通过率在 19-21/22 区间
- [x] DB schema 含 `lios_trace_links` (β-3 已 migrate, e2e DB 1 row 验证)
- [x] governance benchmark 5 iter 数据落档（γ 阶段对比基线）
- [x] β 阶段 7 次蓝图错误已记录归档
- [ ] **`v2.2-phase-β-complete` tag 打到本报告所在 commit + push**（用户授权后执行）
- [ ] γ-5 蓝图 v0.3 §2.2 修订条款 (LIOSAccessControl) 用户复审

启动条件已具备。

---

## 7. 文件清单（Phase β 交付物 · 504 行 + 测试 224 行 + 工具 93 行）

```
src/api/governance.ts   (136) POST /lios/runtime/decide + writeTraceLink + setErrorHandler
src/api/errors.ts       ( 53) 4 个错误码 + APIError + toErrorBody
src/db/migrate_v11{,_down}.ts (87) lios_trace_links 表 + 对称 down
src/index.ts            (+ 2) governanceRoutes 注册
package.json            (+ 4) migrate:v11{,down} + benchmark:governance
tests/v22/governance-api.test.ts  (224) T1-T7（错误码 / verdict / 异步写 / 写失败）
scripts/benchmark-governance.cjs  ( 93) β 路径独立基线（与 benchmark.cjs 对称）
docs/v2.2/{benchmark-beta-chat,benchmark-beta-chat-5iter,benchmark-beta-governance-5iter,real-llm-beta-s1-s22}.txt + phase-beta-complete-report.md
```

---

**文档结束**
