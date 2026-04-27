# 龙码 LIOS（v2.1）

> **LIOS 治理工程化系统**——LLM 客服在治理框架内自由发挥，规则是底线，底线之上自由。
>
> 当前版本：**v2.1**（2026-04-26 锁定 / 2026-04-27 R3 通过）

---

## 母理念（白皮书 §1）

> 规则是底线，底线之上天高地厚任人驰骋。
>
> 在治理框架下，我们运行 LLM 自由发挥，这样才不至于出现一抓就死一放就飞的不平衡的现象。

LI Kernel 治理是核心，**抛弃靠关键词规则来解决致幻 / 目标漂移 / 嘴炮问题**。

---

## 治理总线

```
用户输入
  ↓
ConversationRuntime（保留实体；不再硬编码 phase）
  ↓
ProjectionRepo 重建 ConversationProjection（readonly + frozen）
  ↓
ClaimExtractor 抽取 claims + meta_claims
  ↓
EvidenceBinder 绑定证据（5 档：user_assertion / system_observation / ledger_record / kb_lookup / verifier_result）
  ↓
CandidatePackBuilder 构造 KernelInput + 注入 TenantPolicy
  ↓
LIKernel 评估【两条物理律 + 传入的 TenantPolicy】
  ↓
ActionResolver 查账本，按 Action ID 实现幂等
  ↓
BoundedLLMGenerator 在 bounds 内生成
  ↓
BoundsAuditor 三层审核（结构化 + 语义 + 兜底模板）
  ↓
写入 Ledger（结构化列 + bridge 兼容）
  ↓
回复用户
```

详见 `docs/lios_governance_engineering_whitepaper_v2_1.md`。

---

## 两条物理律

宪法级文档：`docs/two_physical_laws.md`

- **律 1 证据闭合律**：任何 AI 对外的事实性陈述必须可追溯到证据来源。无证据即无输出。
- **律 2 账本守恒律**：已 committed 的 Action 不被重复触发。系统状态由不可篡改的账本独一定义。

---

## 模块导航

| 路径 | 职责 |
|---|---|
| `src/runtime/ConversationRuntime.ts` | v2.1 主控（10 步主流程） |
| `src/runtime/ConversationProjection.ts` | 派生视图 + 不可写原则 |
| `src/runtime/ProjectionRepo.ts` | 投影加载器 / LRU 缓存 |
| `src/extractor/ClaimExtractor.ts` | 含元主张的语义抽取（meta.confirmation/negation/unclear）|
| `src/binder/EvidenceBinder.ts` | 律 1 工程实现（5 档证据等级）|
| `src/builder/CandidatePackBuilder.ts` | 拼接 KernelInput + 派生 candidate_actions |
| `src/policy/TenantPolicy.ts` | 租户策略（claim 集 / slot / action 模板 / forbidden_commitments / reject_claim_types）|
| `src/kernel/v2_1/LIKernel.ts` | 内核（仅持有两律；policy 作为输入参数）|
| `src/kernel/v2_1/EvidenceLaw.ts` | 律 1 评估 |
| `src/kernel/v2_1/ConservationLaw.ts` | 律 2 评估（含 family-track 累计）|
| `src/resolver/ActionResolver.ts` | Action ID 生成 + idempotency_scope 表 |
| `src/generator/BoundedLLMGenerator.ts` | 约束下的最优语言生成 |
| `src/auditor/BoundsAuditor.ts` | 三层审核（结构化 / 语义 / 兜底模板）|

---

## 灰度切换状态（T11 阶段记录）

- **阶段 1（T10 完成 · 2026-04-26）**：缺省走旧链路；header `X-LIOS-Runtime: v2_1` 走新链路 ✅
- **阶段 2（T11 当前 · 2026-04-27）**：缺省切到 v2_1；header `X-LIOS-Runtime: legacy` 紧急回滚 ✅
- **阶段 3（约 1 周后）**：删除整个旧链路（preKernel/promptBuilder/postAudit 与相关 chat.ts 分支）+ 移除 flag

---

## 启动

```bash
# 安装
npm install

# 数据库迁移（先依次跑 v1 → v10）
npm run migrate         # v1 (initial)
npm run migrate:v2
npm run migrate:v3
npm run migrate:v4
npm run migrate:v6
npm run migrate:v7
npm run migrate:v8
npm run migrate:v9      # v9: lios_ledgers 增强字段
npm run migrate:v10     # v10: conversation_projections

# 启动开发
npm run dev             # tsx watch :3210

# 紧急回滚
LIOS_RUNTIME=legacy npm run dev
```

---

## 测试

```bash
# 22 个对抗 case（默认走 v2_1）
node tests/adversarial/runner.cjs

# 紧急走旧链路
LIOS_RUNTIME_HEADER=legacy node tests/adversarial/runner.cjs

# 端到端集成测试（OI-003 工程纪律）
npx tsx tests/e2e/v2_1_smoke.test.ts

# 各组件单元测试
npx tsx tests/projection/projection.test.ts
npx tsx tests/extractor/claim_extractor.test.ts
npx tsx tests/binder/evidence_binder.test.ts
npx tsx tests/builder/candidate_pack_builder.test.ts
npx tsx tests/kernel/likernel.test.ts
npx tsx tests/resolver/action_resolver.test.ts
npx tsx tests/generator/bounded_llm_generator.test.ts
npx tsx tests/auditor/bounds_auditor.test.ts
```

---

## 严格不做的事（白皮书第十节）

- ❌ 不写业务语义关键词列表（"shopee/正确/聯繫人工客服" 等）
- ❌ 不在 LI Kernel 内核持有任何租户字段
- ❌ 不在 ConversationProjection 暴露任何 setter
- ❌ 不让 BoundsAuditor 单纯依赖语义分类器
- ❌ 不让 ActionResolver 用全局 idempotency_scope（必须按 Action 类型分配）
- ❌ 不修改对抗 case 的预期行为来"让测试通过"

---

## 工程纪律（OI-003）

未来每个 Task 完成的"验收标准"必须包含至少一个**端到端集成测试**——
真实从 chat 入口走到 reply 出口，校验 verdict + scope + reply 三项一致。
**不能只有单元测试**。

详见 `docs/v2_1_open_issues.md`。

---

## 开放问题清单

详见 `docs/v2_1_open_issues.md`。

---

## 文档索引

- 白皮书：`docs/lios_governance_engineering_whitepaper_v2_1.md`
- 两律宪法：`docs/two_physical_laws.md`
- R3 失败诊断：`docs/r3_failure_analysis.md`
- 未决项清单：`docs/v2_1_open_issues.md`

---

## 时间戳与权属临时声明

本仓库为龙码协议体系（LungCode Protocol）及 LIOS（逻辑智能操作系统）的专有技术实现。

- **作者**：龙先冕
- **商业化承接主体**：龙码（广州）数字科技有限公司
- **最终权属**：以双方后续签署的正式法律协议为准

详见：[docs/legal/LIOS_时间戳与权属临时声明.md](docs/legal/LIOS_时间戳与权属临时声明.md)

Copyright © 2026 龙先冕. All Rights Reserved.
未经授权禁止使用、复制、修改、分发本仓库任何内容。
