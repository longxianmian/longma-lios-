# lios_assets 系统调研 v0.1

**生成日期**: 2026-04-28
**调研发起**: OI-δ-003 (用户拍板)
**目的**: 为 OI-δ-004 战略决议 (lios_assets 在标典 / 信息资产化路线上的角色) 提供真实情况依据
**调研规则**: 只 read / grep / SQL SELECT, 0 修改代码 / 数据

---

## 1. 代码量盘点

### 文件清单 + LOC

| 文件 | LOC | 用途 |
|---|---|---|
| `src/routes/assets.ts` | 258 | HTTP 4 端点 (ingest / search / get / reindex) |
| `src/services/kbCorpus.ts` | 65 | `getKBSnapshot()` — 60s 缓存 + productNames 提取 |
| `src/services/embedding.ts` | 45 | `embedText()` (调 OpenAI) + `cosineSimilarity` + `rankBySimilarity` |
| `src/service/decision-helpers.ts` (`retrieveKBSnippets` 段) | 47 (line 298-344) | 关键词命中 + KB 片段返回 |
| **总核心 LOC** | **~415** | |

### 配套迁移文件

```
src/db/migrate_v3.ts  — CREATE TABLE lios_assets (line 50)+ 5 个索引 + FTS GIN
src/db/migrate_v5.ts  — ALTER TABLE 加 embedding real[] + embedding_model text 列
```

### 没有的配套

- ❌ 无 worker (queue/workers/ 内无 asset/embedding 处理)
- ❌ 无 cron / 后台异步处理 (reindex 是同步 API)
- ❌ 无独立的 service 层 (kbCorpus + embedding 是工具模块, 不是 service class)

---

## 2. 耦合点完整 grep

### `lios_assets` SQL 命中 (src/, 18 处, 含 2 处 migration)

| 文件 | 行 | 用途 |
|---|---|---|
| `src/db/migrate_v3.ts` | 50, 67-71 | CREATE TABLE + 5 索引 |
| `src/db/migrate_v5.ts` | 5, 9-10 | ALTER 加 embedding 列 |
| `src/service/decision-helpers.ts` | 328 | `retrieveKBSnippets` SELECT (核心: KB 召回入口) |
| `src/services/kbCorpus.ts` | 35 | `getKBSnapshot` SELECT (核心: 60s 缓存 productNames) |
| `src/services/businessFlows.ts` | 33 | 业务流模板加载 (asset_type='business_flow') |
| `src/routes/assets.ts` | 62/114/167/203/213/223/237 | 7 处 CRUD + reindex |
| `src/routes/agent.ts` | 266, 365 | agent desk 后台路由 |
| `src/routes/decisions.ts` | 85, 154 | decisions 路由 |
| `src/routes/chat.ts` | 222, 240 | v2.1 chat 路由 |
| `src/routes/lios.ts` | 182, 237 | v2.1 lios 路由 |
| `src/routes/compareTest.ts` | 46, 60 | 对比测试 |
| `src/queue/workers/intentWorker.ts` | 20, 35 | intent 异步处理 (P1 队列) |

### `kbCorpus` / `getKBSnapshot` 引用 (8 处)

```
src/queue/workers/replyWorker.ts:6,39          — replyWorker 调
src/service/LIOSGovernanceService.ts:35,128    — service 治理决策
src/service/decision-helpers.ts:20,299         — retrieveKBSnippets 调
src/services/preKernel.ts:18                    — 类型 import
src/routes/chat.ts:17,447                       — v2.1 chat
src/services/postAudit.ts:13                    — 类型 import
src/services/factCheck.ts:13,113                — factCheck 引用 kbCorpus 字符串
```

### `retrieveKBSnippets` 调用 (3 处, 2 处真实调用)

```
src/service/LIOSGovernanceService.ts:55         — import 行
src/service/LIOSGovernanceService.ts:141        — Step 2.1: KB 召回升级 inquiry.* 类 binding
src/service/LIOSGovernanceService.ts:180        — Step 6: KB snippets + history 给 generator
```

### 间接依赖图

```
LIOSGovernanceService.decide()
  ├─ retrieveKBSnippets (decision-helpers)
  │   ├─ getKBSnapshot (kbCorpus)
  │   │   └─ SQL: lios_assets WHERE tenant_id + is_indexed
  │   └─ SQL: lios_assets WHERE tenant_id + is_indexed (二次查询)
  └─ getKBSnapshot (直接调, line 128)

POST /lios/assets/reindex
  └─ embedText (embedding.ts) → OpenAI text-embedding-3-small
  └─ UPDATE lios_assets SET embedding, embedding_model, is_indexed
```

---

## 3. 索引机制真实实现

### embedding 列写入路径

**唯一写入入口**: `POST /lios/assets/reindex` (`src/routes/assets.ts:182-256`)

```
Step 1: UPDATE lios_assets SET is_indexed = TRUE WHERE is_indexed = FALSE
Step 2: SELECT 所有 is_indexed=TRUE AND embedding IS NULL 的行
Step 3: 对每行 await embedText(name + content) → OpenAI API 同步调用
Step 4: UPDATE lios_assets SET embedding = $1::float4[], embedding_model = $2
```

**关键事实**:
- ❌ **不是** cron / worker 异步处理
- ❌ **不是** 队列 (queue/streams)
- ✅ 同步 HTTP API, 在请求线程内 for-loop 调 OpenAI (n 个 asset → n 个 OpenAI 调用串行)
- ⚠️ 大批量 reindex (比如 1000 条) → HTTP timeout 风险; 单条 try/catch, 失败计入 `skipped`

### embedding model 配置

```typescript
// src/services/embedding.ts:5
export const EMBEDDING_MODEL = 'text-embedding-3-small';
export const EMBEDDING_DIM   = 1536;
```

**hardcoded**, 不读 env / config。1536 维。

### `lios_embedding_cache` 表用法

```
schema: id (UUID PK) / text_hash (UNIQUE) / embedding (real[]) / created_at
```

**重要发现**: `grep` 全代码库 `lios_embedding_cache`:

```
$ PGPASSWORD=lios1234 psql -tAc "SELECT count(*) FROM lios_embedding_cache;"
0
```

**lios_embedding_cache 当前 0 行, embedding 缓存机制 schema 存在但实际未启用** (代码里没人 SELECT 或 INSERT 这张表; embedText 每次直接调 OpenAI, 不查缓存)。

### `is_indexed` 翻转时机

- 唯一翻转点: `POST /reindex` 第一步 (UPDATE ... SET is_indexed = TRUE)
- 没有自动翻 (ingest 后必须显式调 reindex)
- 没有反向翻 (TRUE → FALSE 没机制)

### FTS GIN 索引维护

```sql
CREATE INDEX idx_lios_assets_fts ON lios_assets USING gin(
  to_tsvector('simple', COALESCE(name,'') || ' ' || COALESCE(content,''))
);
```

PG 自动维护 (INSERT / UPDATE 触发), 不需要 reindex 手动重建。

**但: `retrieveKBSnippets` SQL 实际不用 FTS** (见 §4):
```sql
SELECT name, content FROM lios_assets WHERE tenant_id = $1 AND is_indexed = TRUE ...
```

只用 `tenant_id` 索引 + JS 内存过滤。FTS GIN 索引**只在 `routes/assets.ts` 的 search API 用到** (见 line 114), 主决策路径 (`retrieveKBSnippets`) 不用。

---

## 4. 多租户隔离现状

### `tenant_id` 列约束

```
tenant_id | text | not null
```

✅ NOT NULL, 但**没外键** (不引用 lios_tenants(tenant_id) — 这跟 γ-2 的 lios_tenant_policies 不同)。

### 当前实测数据

```
SELECT DISTINCT tenant_id FROM lios_assets;
 tenant_id
-----------
 demo
(1 row)

SELECT scope, count(*) FROM lios_assets GROUP BY scope;
   scope    | count
------------+-------
 enterprise |     4
(1 row)
```

**只有 'demo' tenant 4 行数据**, 全部 `scope='enterprise'`。多租户从未真正启用。

### `retrieveKBSnippets` 是否真按 tenant_id 过滤

```sql
-- src/service/decision-helpers.ts:326-334
SELECT name, content FROM lios_assets
WHERE tenant_id = $1
  AND is_indexed = TRUE
  AND content NOT LIKE '[待轉錄：%'
  AND content NOT LIKE '[待转录：%'
```

✅ 真实 tenant_id 过滤 (参数化, 不是字符串拼接, 无注入风险)。

### `scope` 列与 `tenant_id` 关系

```
CHECK constraint: scope ∈ ('industry', 'enterprise', 'project', 'task', 'role')
```

- `tenant_id`: 商户标识 (owner)
- `scope`: 资产可见性维度 (industry 行业级 / enterprise 企业级 / project / task / role)
- `scope_ref` (默认 ''): scope 引用值 (比如 scope='project' 时 scope_ref='project_xyz')

**两者语义独立**:
- `tenant_id` 是物理隔离 (无外键但 SQL WHERE 强制)
- `scope` 是逻辑分类 (用于检索过滤, 不影响隔离)

**当前数据全部 scope='enterprise'**, scope 维度的实际工程效果未启用。

---

## 5. 性能边界估算

### 当前 4 行下 SQL 实测

```
EXPLAIN ANALYZE SELECT name, content FROM lios_assets WHERE tenant_id='demo' AND is_indexed=TRUE ...

Index Scan using idx_lios_assets_tenant on lios_assets
  (cost=0.14..8.17 rows=1 width=64) (actual time=0.022..0.025 rows=4 loops=1)
Planning Time: 1.376 ms
Execution Time: 0.064 ms
```

**走 `idx_lios_assets_tenant` 索引扫描, 0.064ms execution**。

### 4000 行预估 (静态分析)

- btree 索引扫描复杂度 O(log n), 4000 行 → 约 12 次比较
- 但 retrieveKBSnippets SELECT **不带 LIMIT** (返回全部 is_indexed=TRUE 行), JS 内存里 for-loop 关键词匹配
- 4000 行下: SQL ~0.5-1ms, JS for-loop 4000 次 substring 检查 ~10-20ms
- `getKBSnapshot` 有 `LIMIT 100`, 但 retrieveKBSnippets 没有
- **预估 4000 行下单次 retrieveKBSnippets ~15-30ms**, 仍远小于 LLM 调用 (4 秒)

### `retrieveKBSnippets` 在 `decide()` 耗时占比

- δ-2 实测: P50 4322ms (10 runs)
- 主要耗时: LLM (claim extraction + bounded gen + audit retry) ~4s
- KB 召回耗时 (4 行下 ~0.1ms, 可忽略)
- **当前规模 KB 召回 < 0.01% 总耗时**

### lios_embedding_cache 0 行

embedding 缓存机制 schema 存在但**未启用**, 这是潜在性能优化点 (avoid 重复调 OpenAI text-embedding-3-small) 但未实施。

---

## 6. 跟"独立资产化系统"对照

| 特性 | lios_assets | 期望资产化系统 | 差距 |
|---|---|---|---|
| 资产登记 (CRUD) | ✅ POST /ingest | ✅ | 0 |
| 版本管理 | ❌ 无 version 列, 仅 updated_at 时间戳 | ✅ 多版本 / diff / rollback | 100% |
| 资产流转 (订阅 / 授权) | ❌ 无表, 单 tenant_id 强隔离 | ✅ 跨租户授权 / 订阅 / 转移 | 100% |
| 密码学锚定 (hash / OTS) | ❌ content 直接存, 无 hash 字段 | ✅ 内容 hash + 可选 OTS | 100% |
| 跨产品应用共享 | ❌ tenant_id WHERE 强制隔离 | ✅ scope 跨 app 共享 | 100% |

### 结论判定

**lios_assets 是"简单租户 KB 表", 不是资产化系统的前身**。

工程**完全另一个方向**:
- lios_assets 设计目的: 给 LIOS 治理决策提供 KB 召回的"配料" (产品名 / 流程 / 政策)
- 资产化系统设计目的: 信息载体本身 (登记 / 版本 / 流转 / 锚定 / 共享 / 跨应用)

两者**只有一个交集**: "登记" 这个动作。其他 4 项核心特性 (版本 / 流转 / 锚定 / 共享) lios_assets 都没有, 而且 schema 设计上**也没有为这些扩展留接口**。

---

## 7. 战略判断: 情况 A / B / C 哪一种

按 OI-δ-003 三分类:
- **情况 A**: 简单 KB (200-400 LOC, 1-2 处耦合) → lios_assets 可临时承担标典 KB
- **情况 B**: 复杂系统 (1000+ LOC, 多处耦合) → 标典直接用 lios_assets 风险高
- **情况 C**: 已接近资产化系统 → 重新审视战略

### 我的判定: **情况 A (简单 KB)**, 但带一个约束

**符合 A 的证据**:
- 总核心 LOC ~415 (在 200-400 区间附近, 只略超)
- 调用关键路径只有 1 个 (LIOSGovernanceService.decide → retrieveKBSnippets)
- 性能在 4000 行下仍远低于 LLM 时间
- 没有复杂工程 (无 worker / 无 cron / embedding 同步处理)

**约束 (不要硬塞 A 的原因)**:
- 17 处 SQL 命中显示 lios_assets 已经被多个路由 (chat / agent / decisions / lios / compareTest) **集成深** — 这是耦合复杂度的表象
- 不过: 这 17 处主要是 SELECT, 多数是重复 KB 召回逻辑, 没有写竞争 (只有 ingest/reindex 写)
- **真正问题不是耦合, 是缺特性** — lios_assets 没版本 / 没流转 / 没锚定 / 不跨租户共享, 用它做"标典 KB" 行 (一种简单 KB 用途), 用它做"标典资产管理" 不行 (缺核心资产化特性)

**判定细化**: **A.1 — lios_assets 可作"简单 KB" 临时承担标典 KB 角色, 但不能作"标典资产管理"**。

---

## 8. 候选方案 X / Y / Z 可行性评估

### 候选 X (按交接书原顺序: 资产化系统作为独立基础设施层 P0)

**可行性**: ✅ **完全可行**

- 不动 lios_assets, 它继续作 LIOS 内部 KB
- 资产化系统 P0 独立工程, 用新表 / 新 service / 新 API
- 标典 P0 等资产化系统 P0 完成后启动, 用资产化系统的资产管理能力
- **优点**: 工程边界清晰, lios_assets 不被滥用, 资产化系统从零正向设计 5 项核心特性
- **缺点**: 工程顺序长 (资产化 → 标典), 标典启动时间晚

### 候选 Y (标典先做, 临时用 lios_assets)

**可行性**: ⚠️ **部分可行, 视标典需求范围而定**

- **如果标典只用"招投标知识 KB"** (产品 / 政策 / 模板查询): ✅ lios_assets 可承担, 跟现有 demo (X9 产品 / 退货流程) 同模式
- **如果标典需要"招投标资产管理"** (标书文档登记 / 版本 / 审计 / 流转): ❌ lios_assets 缺 4/5 项核心资产化特性, 不能承担
- **优点**: 标典启动时间提前 (不等资产化 P0)
- **缺点**: 如果 lios_assets 被拉胖去做资产化的事, 既毁 lios_assets 的 KB 焦点, 又给资产化系统留下 legacy 坑
- **建议**: 选 Y 必须严格限定"lios_assets 只做 KB, 标典资产管理仍等资产化 P0"; **不能把标典所有需求都压 lios_assets**

### 候选 Z (并行: lios_assets 演进为资产化 + 标典同时用)

**可行性**: 🔴 **不推荐**

- lios_assets schema 设计为 KB 召回, 强行加 version / 流转 / 锚定 / 跨租户共享 = 重写
- 重写时间 ≈ 资产化系统 P0 从零做时间, 但还要带历史包袱 (现有 4 行数据 + 17 处耦合代码迁移)
- **风险**: lios_assets 现在被 v2.1 chat / agent / decisions 等 5 个路由依赖, 演进过程中任何 schema 变化都可能破坏现有功能 (v2.2 退化锚点失效)
- **唯一优势 (假设的)**: 复用 lios_assets 已有 4 行数据 — 但 4 行数据**可以 ingest 进新资产化系统**, 不需要继承 lios_assets 的设计包袱

---

## 9. 建议 (不是决议, 决议归用户)

基于 §7 + §8:

- **首选 候选 X** (按交接书原顺序): 工程清洁, 风险最低
- **次选 候选 Y 限定版** (标典先做, 但只用 lios_assets 做 KB): 加快标典启动, 但严格边界
- **不推荐 候选 Z**: 演进路径风险高, 不如 X 重做

**关键约束 (无论选 X / Y)**:
- lios_assets 不动 schema (避免破坏 v2.2 退化锚点)
- `lios_embedding_cache` 表存在但未启用是潜在 OI (优化点 / 或确认废弃)

---

**调研结束**。
