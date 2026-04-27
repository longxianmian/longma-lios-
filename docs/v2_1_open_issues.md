# LIOS v2.1 落地施工 — 未决项清单（Open Issues）

> 维护规则：每个未决项明确触发 Task、负责回归点、修复门槛。R1/R2/R3 回归前必须复核本表。

---

## OI-001 · S19 转人工完整流程边界波动（已重新归类）

| 字段 | 值 |
|---|---|
| 状态 | 🟡 可继续推进（归类为 LLM 边界波动） |
| 发现时间 | T1 完成时（2026-04-26） |
| R1 复核结果 | 8 次累计：1 pass / 7 fail —— 出现 pass 即否定"5/5 稳定失败"判定，归 LLM 边界波动 |
| 触发回归点 | **R3（T10 后）必须验证已消除** |
| 责任工序 | 旧 chat.ts 主链路 LLM 自由判断"是否升级人工"，无结构化守恒 |

### 现象

- 命令：`node tests/adversarial/runner.cjs S19`
- T1 后连跑 5 次：5/5 fail（verdict 序列恒为 `[0, 0, 0]`）
- R1 时 22 case 全跑：1/1 pass
- R1 后 3 次单跑：1/3 pass（verdict 偶尔出现 `[0, 0, -2]`）
- **结论**：路径能走通，输出在边界抖。归 LLM 自由判断的非确定性。

### 期望 vs 实际

```
T1: USER「我之前买的产品坏了，我要找人工」
    expected v=0  ✓
T2: USER「订单 2988789，X9 无法开机」
    expected v=0  ✓
T3: USER「麻烦尽快帮我处理」
    expected v=-2 (escalate, 触发 handoff_context 打包)
    actual    v=-2 偶尔，多数 v=0
```

### 根因（更新）

旧 chat.ts/preKernel 在 not_found 第 3 轮"是否升级"由 LLM 自由判断；缺乏：
- 结构化的 escalation.request 主张抽取（v2.1 由 T3 ClaimExtractor 解决）
- Action ID 守恒（v2.1 由 T7 ActionResolver 解决）
- 升级阈值由账本派生（v2.1 由 T10 Runtime + ConversationProjection 解决）

### 修复路径

**路径 A（v2.1 自然解）—— 已锁定**：
- T3 ClaimExtractor 已能抽 escalation.request（C7 测试通过）
- T7 ActionResolver 完成后，相同 conversation 的转人工 action 由 ID 守恒，不再由 LLM 重判
- T10 Runtime 切换主链路后，escalation 决策走 Kernel 律 2 + ActionResolver 守恒，确定性消除波动

**R3 验证清单**：
- [ ] S19 跑 5/5 全过
- [ ] handoff_context 三个字段非空
- [ ] 若 R3 仍 <5/5 → 停下排查 ActionResolver / Kernel 律 2 落地是否到位

---

## OI-002 · S9 复合主张退货边界波动

| 字段 | 值 |
|---|---|
| 状态 | 🟡 可继续推进（LLM 边界波动） |
| 发现时间 | R1 回归（2026-04-26） |
| 频次 | 3 次单跑：2 pass / 1 fail |
| 触发回归点 | **R3（T10 后）必须验证已消除** |
| 责任工序 | 旧 preKernel 对复合主张（refund + purchase + defect）的 scope 输出结构波动 |

### 现象

case：`USER「我想退货，我买的大鹅羽绒服是残次品」` → 期望 v=0、scope 含 `purchase_proof / product_name_clarify / product_condition_evidence`。

旧 preKernel 输出 scope 在 LLM 单次温度内偶发遗漏其一。R1 全跑遇到一次。

### 修复路径

T3 ClaimExtractor 已可稳定抽出 `refund.request + purchase.assertion + defect.assertion`（C6 测试通过）；T10 Runtime 切换后，scope 由 ClaimExtractor 结构化主张派生，不再由旧 LLM scope-tag 自由生成 → 边界波动应消除。

**R3 验证清单**：
- [ ] S9 跑 5/5 全过

---

## OI-003 · 工程纪律：未来 Task 验收必含端到端集成测试

| 字段 | 值 |
|---|---|
| 状态 | 🟢 立即生效 |
| 触发回归点 | R3 翻车暴露（2026-04-26）|

### 背景

T1–T9 单元测试全过、R3 端到端只 5/22。

每个 Task 的单测验证了组件**孤立行为**，但都没验证**组件协同**：
- T6 Kernel 单测验证 hold/accept/reject 各档可达，未验证"chitchat 输入 → reject"
- T7 ActionResolver 单测验证 hash 稳定，未验证"verifier shop_id 与 mock_orders 对齐"
- T8/T9 单测在隔离 bounds 下验证，未走真实 chat 入口

### 纪律

**未来每个 Task 完成的"验收标准"必须包含至少一个端到端集成测试**：
- 真实从 chat 入口（`POST /lios/chat` 或 Runtime.handle）走到 reply 出口
- 至少校验三项一致：verdict (legacy 与 new) / scope / reply 实际内容
- 不允许"单测全过"作为完成标志

### 应用到现有未结 Task

- **T11 灰度切换 + 文档同步**：完成验收除原条目外，必须在 PR 体内附 R3 ≥19/22 的运行截图
- 任何后续修复 / 重构：不得仅靠单测交付

---

## OI-004 · T11 阶段 3：删除旧链路

| 字段 | 值 |
|---|---|
| 状态 | 🟡 排程中 |
| 计划执行日 | **2026-05-04**（R3 通过 + 7 天观察期后）|
| 触发条件 | 期间生产/测试环境无 v2_1 严重问题；OI-001/002 维持消除态 |

### 删除清单

- `src/services/preKernel.ts`
- `src/services/promptBuilder.ts`
- `src/services/postAudit.ts`
- `src/services/governance.ts`（旧）
- `src/services/governanceKernel.ts`（旧）
- `src/services/factCheck.ts`（旧）
- `src/routes/chat.ts` 内 v2_1 短路之后的整段 legacy 代码（缩减到 < 100 行）
- 移除 `LIOS_RUNTIME` env / `X-LIOS-Runtime` header 处理
- runner.cjs 移除 `LIOS_RUNTIME_HEADER` 支持

### 删除前必须

- [ ] 7 天内生产环境无 v2_1 严重故障告警
- [ ] R3 全量再跑 ≥19/22 + 端到端 7/7
- [ ] grep 0 命中 `is_pure_affirmation` / `detect_order_source` / `escalation_repeat_regex`
- [ ] grep 0 命中 `phase` 字段写死

---

## OI-005 · "大鵝羽絨服" 复合主张三项诊断

| 字段 | 值 |
|---|---|
| 状态 | 🟡 已诊断，未修复（等用户裁决）|
| 发现时间 | 2026-04-27（v2.1 阶段 2 上线后第一次真实对话验证）|
| 触发用例 | "我買的大鵝羽絨服是殘次品"（首轮）+ "订单 9989890" + "麻烦尽快帮我处理" |
| 诊断脚本 | `tests/diagnostics/oi005_eider_diagnose.ts` |

---

### 诊断 1 · ClaimExtractor 抽取结果（2/3 命中）

**期望（用户）**：
- refund.request
- purchase.assertion(product_name=大鵝羽絨服)
- product_condition.assertion(condition=殘次品)

**实际**：

```json
[
  { "type": "purchase.assertion",
    "content": { "what": "大鵝羽絨服" } },
  { "type": "defect.assertion",
    "content": { "what": "大鵝羽絨服", "detail": "殘次品" } }
]
```

| 期望主张 | 实抽 | 备注 |
|---|---|---|
| refund.request | ❌ **缺失** | 用户说的是陈述（"是殘次品"），未明说"我要退货"。LLM 没主动外推到 refund.request。 |
| purchase.assertion(product_name=大鵝羽絨服) | ✅ | 字段名是 `what`，不是 `product_name`——但语义对齐。 |
| product_condition.assertion(condition=殘次品) | ✅（命名差异） | 类型是 `defect.assertion`（不是 `product_condition.assertion`）；字段是 `detail`（不是 `condition`）。 |

**两点结构性观察**：
1. **类型集差异**：当前 ClaimExtractor 只有 `defect.assertion`（无 `product_condition.assertion`）。语义可承载，但下游 scope 映射、prompt 引导都用 `defect.*` 标签。
2. **字段名差异**：`what` / `detail` vs 用户期望的 `product_name` / `condition`。下游 `synthesizeScope` / `detectUnknownProduct` 当前已能从 `what` 取值，但任何外部消费方（例如 agent UI）若按 `product_name` 字段读会取到空。

**refund.request 缺失的根因假设**：
- ClaimExtractor prompt 第 2 条只说"过去购买含义 → 必须额外抽 purchase.assertion"，没规定"defect 陈述 → 应隐含 refund.request"。
- 用户在客服语境下说"是殘次品"几乎必然是退货前奏；LLM 对此场景的常识没被显式 prompt 强化。

---

### 诊断 2 · EvidenceBinder 对"大鵝羽絨服"的处理（符合律 1 期望）

**KB 当前 productNames**（demo 租户）：
```
["退貨流程", "查詢訂單流程", "投訴流程", "龍碼Pro智能手環 X9"]
```
不含"大鵝羽絨服"。

**实际绑定**：
| 序号 | claim.type | content.what | evidence_source | level | pending | reason |
|---|---|---|---|---|---|---|
| 1 | purchase.assertion | 大鵝羽絨服 | user_assertion | 1 | true | pending_evidence |
| 2 | defect.assertion   | 大鵝羽絨服 | user_assertion | 1 | true | pending_evidence |

`pack.has_pending=true`、`highest_level=1`。

**对照期望**：
- 期望：KB miss → 标 pending_evidence → 触发律 1 → hold + 追问 ✅ 全过

**但有一个隐藏问题**：
- 当前 `augmentDecisionForUnknownProduct` 只在 **defect.assertion 且 *无* purchase.assertion** 时触发产品名澄清（这是 R3 修复时的硬规则，为了让 S3/S10 走"问订单号"而 S4 走"澄清品名"）。
- 本用例同时有 purchase + defect → **不会触发产品澄清** → bot 直接问订单号，**不告诉用户"本店没有'大鵝羽絨服'记录"**。
- 用户角度看上去像"AI 没听见我说什么商品"——这是体验层缺陷，不是律层错误。

---

### 诊断 3 · handoff_context 缺业务核心字段（4/7 缺）

**入库 `lios_agent_sessions.handoff_context`**：
```json
{
  "user_original_complaint": "我買的大鵝羽絨服是殘次品",
  "verdict_trajectory": ["hold", "hold", "hold", "escalate"],
  "collected_verification": [
    { "verifier": "order_lookup: not_found" }
  ]
}
```

**期望字段对照**：
| 字段 | 状态 | 实值 |
|---|---|---|
| user_original_complaint | ✅ | "我買的大鵝羽絨服是殘次品" |
| product_name | ❌ **缺** | — |
| product_condition | ❌ **缺** | — |
| reason | ❌ **缺** | — |
| order_id | ❌ **缺** | — |
| verdict_trajectory | ✅ | 4 项 |
| collected_verification | ✅ | 1 条 verifier 结果 |

**根因**：
- `buildHandoffContextFromLedger` 当前只回放 `kernel.scored` 行的 `verdict` 与 `verifier_summary`，**没从 `claims` 列回扫**取业务字段。
- `lios_ledgers.claims` 列实际有所有轮次的 claim payload（v9 加的结构化列），但 `buildHandoffContextFromLedger` 没读它。

**客服 agent 看到的现状**：
- 知道用户的原话
- 知道律 2 触发了 escalate
- 知道某次 verifier 查到 order_not_found
- **不知道**：商品名（大鵝羽絨服）/ 状态（殘次品）/ 用户给过的订单号（9989890）/ 退货意图

→ agent 实际接手时几乎要重新问一遍。

---

### 修复优先级（如果你决定修）

| 问题 | 严重度 | 工程量 | 是否动律层 |
|---|---|---|---|
| ClaimExtractor 漏 refund.request | 中 | prompt 加一条规则（"defect 陈述 → 也抽 refund.request"），15 min | 不动律 |
| 字段名 `what`/`detail` vs `product_name`/`condition` | 低 | 命名规范 + 下游兼容；半小时；或保持现状由 bridge 层翻译 | 不动律 |
| `defect.assertion` vs `product_condition.assertion` | 低 | 同上，命名问题 | 不动律 |
| augmentDecisionForUnknownProduct 不触发"未知商品澄清"（同时有 purchase + defect 时）| 中 | 改触发条件：**KB miss + claim 含具体品名** 即触发，不再排斥 purchase.assertion；S3/S10 用别的方式区分 | 不动律 |
| handoff_context 缺 product_name/order_id/reason/condition | **高** | `buildHandoffContextFromLedger` 从 `lios_ledgers.claims` 列回扫聚合；30-45 min | 不动律 |

**所有修复都不动两律**，属于"工程化推导"层调整。

---

### 建议下一步

依严重度 → 依次修：
1. **handoff_context 字段补全**（最高优先：直接影响 agent 接手质量）
2. **ClaimExtractor 加 refund.request 隐含规则**（修后 R3 跑回归确认 S9 不变）
3. **augmentDecisionForUnknownProduct 触发条件细化**（修后跑 S3/S4/S10 确认不退化）
4. 命名差异如要统一，独立做（影响面较大，需要改类型 + 多处下游）

每修一项立即跑相关 case 子集 + e2e 7/7（OI-003 纪律）。

---

## OI-006 · 主张 Schema 规范化（v2.2 升格任务）

| 字段 | 值 |
|---|---|
| 状态 | 🔵 升格至 v2.2 核心任务（**v2.1 不实现**）|
| 升格时间 | 2026-04-27（OI-005 诊断暴露）|
| 优先级 | v2.2 **首要任务** |

### 背景

OI-005 诊断暴露：当前各 claim_type 的字段命名漂移：

- `purchase.assertion` 用 `what` 字段表示商品名
- `inquiry.product` 用 `product_name` 字段
- `defect.assertion` 用 `detail` 字段表示状态
- 用户/agent UI/外部消费方期望的字段名是 `product_name` / `condition`

这不是 bug——LLM 在没有强制 schema 约束时选了语义合理的字段名。
但下游（handoff_context 聚合、scope 合成、agent UI 渲染）需要一致的字段名才能可靠取值。

### 范围（v2.2 设计目标）

1. 白皮书 v2.2 引入"**主张类型库 Schema**"
2. 每个 claim_type 显式定义标准字段：
   ```typescript
   {
     "purchase.assertion": {
       required_fields: ["product_name"],
       optional_fields: ["purchased_at", "channel"]
     },
     "defect.assertion": {
       required_fields: ["product_name", "condition"],
       optional_fields: ["proof"]
     },
     ...
   }
   ```
3. ClaimExtractor 在 LLM 输出后做 schema 校验 + 字段重命名
4. 下游消费方按 schema 字段名读取（不再各自猜字段）

### 影响面

- 改 `src/extractor/ClaimExtractor.ts`（schema 校验层）
- 改 `src/policy/TenantPolicy.ts`（policy 内嵌 claim schema）
- 改所有读 `claim.content` 的下游：`EvidenceBinder` / `synthesizeScope` / `buildHandoffContextFromLedger` / `detectUnknownProduct`
- 测试需重写部分单测预期字段名

### 不在本轮做的理由

- v2.1 刚落地稳定（R3 21/22）；schema 重构会牵动多处下游
- 应当作为白皮书 v2.2 的"治理纪律升级"独立项目
- 本轮 OI-005 修复用 bridge 层兼容（OI-005 修 1 在 handoff 聚合时按字段优先级 `product_name ?? what`），不动 schema

### 跟踪

进 v2.2 后从 OI-006 开始；本文档届时迁移到 v2.2 OI 清单。

---

## OI-008 · OpenTimestamps 升级（24 小时后必做）

| 字段 | 值 |
|---|---|
| 状态 | ⏳ 待执行 |
| 触发日期 | 2026-04-28（v2.1 时间戳锚定后 24 小时） |

### 任务

对 `artifacts/timestamp-lios-v2.1/ots-proofs/` 下所有 .ots 文件运行：

```bash
cd artifacts/timestamp-lios-v2.1/ots-proofs/
for f in *.ots; do ots upgrade "$f"; done
```

升级后 .ots 文件包含 Bitcoin merkle proof，证明已被某个比特币区块永久确认。
完成后再 git commit 一次："legal(ots): 升级时间戳证明（已被 Bitcoin 区块确认）"

### 背景

OpenTimestamps 有两阶段：
1. **stamp 阶段**（2026-04-27 已完成）：立即生成 .ots，已提交到 OTS 日历服务器（4 节点）
2. **upgrade 阶段**（待执行）：等比特币区块确认后，把日历服务器承诺升级为真正的比特币区块证据

升级前 `ots verify` 显示 "Pending confirmation in Bitcoin blockchain"；
升级后显示 "Success! Bitcoin block N attests existence as of YYYY-MM-DD HH:MM:SS UTC"。

---

## 修订日志

- 2026-04-26 init — 创建文档；登记 OI-001（S19 起初判 5/5 稳定失败）
- 2026-04-26 R1 — OI-001 重新归类为 LLM 边界波动；新增 OI-002（S9 同类）；解除"禁止推进 T4"门槛；改由 R3 复核
- 2026-04-26 R3 — 新链路 5/22 翻车；登记 OI-003（端到端集成测试纪律）；要求 R3 修复后达 ≥19/22 才能推进 T11；详细诊断见 `docs/r3_failure_analysis.md`
- 2026-04-27 R3 修复 — 5 Cluster (A/B/C/D/E) 全部修复；新链路 21/22 (S12 单 case LLM 边界波动，单跑 3/3 pass)；超目标 ≥19/22；OI-001 / OI-002 实质消除（S19 stable pass、S9 stable pass）；准许进入 T11
- 2026-04-27 T11 阶段 2 — 缺省切到 v2_1；legacy kill-switch 保留 (`LIOS_RUNTIME=legacy`)；白皮书 + 两律宪法入仓；端到端集成测试 7/7 通过；登记 OI-004（阶段 3 删除排程到 2026-05-04）
- 2026-04-27 v2.1 上线后第一对话验证 — 登记 OI-005（"大鵝羽絨服"复合主张三项诊断）：ClaimExtractor 漏 refund.request（2/3 命中）；EvidenceBinder 律 1 路径符合期望但 unknown-product 不澄清（用户体验隐患）；handoff_context 缺 product_name/order_id/reason/condition 四项业务核心字段（4/7 缺）；诊断脚本 `tests/diagnostics/oi005_eider_diagnose.ts`
