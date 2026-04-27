# LIOS 两条物理律 · 治理宪法

> 本文档是 LIOS 治理系统的**最高准绳**，等级高于任何业务策略、租户配置、产品需求或工程便利。
> 任何与本文档冲突的工程决策都必须停下评估；任何运行时违反本文档的输出都必须被拦截。
>
> 本宪法独立于产品发布周期；版本变更必须有合宪性审查。

---

## 律 1：证据闭合律（Evidence Closure Law）

> **任何 AI 对外的事实性陈述必须可追溯到证据来源。无证据即无输出。**

### 1.1 证据来源等级（从弱到强）

| 等级 | 来源 | 描述 |
|---|---|---|
| 1 | `user_assertion` | 用户口述 |
| 2 | `system_observation` | 系统观察（meta-claim、空输入、运行期事实）|
| 3 | `ledger_record` | 账本历史（投影 / Ledger 可推断的过去事实）|
| 4 | `kb_lookup` | KB 命中（企业资产数据）|
| 5 | `verifier_result` | 外部系统核验（订单 verifier、KYC、库存等）|

### 1.2 律的执行

- **低等级证据不能支撑高承诺度的输出**
- 用户口述（等级 1）不能支撑"为您办理"这类承诺（需 ≥ 等级 3）
- KB 未命中时，AI 必须明确声明"系统未记录"，**不可凭空补充**
- 任何 candidate_action 都必须声明 `minimum_evidence_level`；运行期低于该等级 → `verdict=hold`

### 1.3 律治理的病

| 病 | 表现 | 律 1 如何治 |
|---|---|---|
| 致幻 | AI 编造产品规格 / 价格 / 政策 | KB 未命中 → 标 `pending_evidence` → bounds.must_not 含 `fabricate_kb_content` |
| 嘴炮 | AI 承诺"已为您处理" 但系统未发生动作 | 等级 1 user_assertion 不能触发 commit；must_not 含 `commit_unverified` |
| 越权陈述 | AI 谈论本店未售商品 | scope `product_name_clarify` + 律 1 hold |

### 1.4 工程实现锚点

- `src/binder/EvidenceBinder.ts` —— 证据等级判定
- `src/kernel/v2_1/EvidenceLaw.ts` —— 律 1 评估
- `src/auditor/BoundsAuditor.ts` —— 三层审核（结构化 + 语义 + 兜底）

---

## 律 2：账本守恒律（Ledger Conservation Law）

> **已 committed 的 Action 不被重复触发。系统状态由不可篡改的账本独一定义。**

### 2.1 律的执行

- **账本是状态的唯一真相源**
- 任何决策前先查账本：是否对应已 committed 的 Action？
  - 已 committed → 直接返回引用，**不生成新 Action**
  - 未 committed → 走完整流程后写账本
- Action ID 由结构化字段哈希生成（白皮书 §5.7），非 LLM 自由判断
- 同一 conversation 内同 intent_family 累计 turn ≥ 阈值 → `should_escalate=true`

### 2.2 律治理的病

| 病 | 表现 | 律 2 如何治 |
|---|---|---|
| 目标漂移 | 用户三轮换不同措辞请求同事，每轮 AI 都重新决策 | family-track 累计 + escalation |
| 重复执行 | 同一退款被重复触发 | Action ID 幂等（idempotency_scope）|
| 状态污染 | 系统状态由 LLM 推断而非账本派生 | `phase` 不再是数据库字段，仅为 ConversationProjection 推导值 |
| "正确" 5 次循环 | 旧系统反复追问同一确认 | meta.confirmation 结构性绑定到 last_system_question |

### 2.3 派生视图不可写原则（Read-Only Projection Principle）

> **派生视图绝不成为第二真相源。派生视图绝不可独立写入。任何状态变化必须先写账本，再触发投影更新。**

实施约束：
- 投影对象 `readonly`
- 任何"修改"实际是返回新投影实例
- 投影更新只接受"从账本重算"或"账本新增记录后增量更新"
- 单元测试必须验证：销毁投影后从账本重建结果一致

### 2.4 工程实现锚点

- `src/runtime/ConversationProjection.ts` —— 派生视图（readonly + freeze）
- `src/runtime/ProjectionRepo.ts` —— 投影加载器
- `src/resolver/ActionResolver.ts` —— Action ID 生成 + idempotency_scope
- `src/kernel/v2_1/ConservationLaw.ts` —— 律 2 评估 + family-track 累计

---

## 物理律归约表

LIOS 不接受其它候选律——它们都被归约为律 1 或律 2 的工程化推导：

| 候选律 | 实际归属 | 归约逻辑 |
|---|---|---|
| 证据律 | **保留为律 1** | 基础律，不可归约 |
| 守恒律 | **保留为律 2** | 基础律，不可归约 |
| 核验律 | 归入律 1 | 核验失败 = 证据不足 |
| 升级律 | 归入律 2 | 同 intent_family 反复 pending 触发升级 |
| 终结律 | 归入律 2 | 已写入最终决议的 Action 不可再生 |
| 一致律 | 归入律 1 + 律 2 | 输出与账本一致 = 律 2；输出与证据一致 = 律 1 |

---

## 物理律之外 —— 行为规则降级

核验、重试、升级、终态封锁这些**具体行为，不是物理律，是物理律的工程化推导**：

```
物理律（不可变）
    ↓ 推导
Runtime 状态转移规则（可调整阈值）
    ↓ 表现
具体对话行为
```

**阈值可调（"事不过三"是默认值），物理律本身不变**。

例如：
- 升级阈值 `escalation_threshold=3` 是默认值，不同行业/租户可调（医疗 demo 是 2）
- 同 intent_family 应该把多个 action_type 聚合（设计层修复，不是律本身改变）
- 但"已 committed 的不重触发"这一律本身永不变

---

## 跨行业不变性

律 1 与律 2 在所有行业普世适用，构成 LIOS 的**普世信任引擎**：

| 行业 | 律 1 实例 | 律 2 实例 |
|---|---|---|
| 客服（电商） | "已为您退款" 需要 verifier_result | 同订单同原因只触发一次退款 |
| 法律 | "符合判例" 需要 ledger_record / kb_lookup | 同案件不重复立案 |
| 医疗 | "推荐用药" 需要专业核验 | 同处方不重复签发 |
| 教育 | "通过考核" 需要正式判分 | 同学生同科目不重复结评 |

**行业语义管线（claim 类型集 / 槽位定义 / KB / Policy）可变；治理管线（律 1 + 律 2 + 三层审核）不变**。

---

## 修宪程序

本宪法的任何修改必须满足：

1. 原文逐字引用（不允许"调整一下表述"式默改）
2. 提交合宪性影响评估：本次修改是否改变两律语义？
3. 若改变两律语义 —— 需要发布新版本号 v3.x，重做对抗 case 全集
4. 若仅扩展工程实现细节 —— v2.x 子版本即可

任何工程师对本文档的"快速调整"建议都应被视为高风险工程提案，需要审议。

---

**版本**：v2.1
**生效日**：2026-04-26（白皮书锁定日）/ 2026-04-27（R3 通过日）
**状态**：active
