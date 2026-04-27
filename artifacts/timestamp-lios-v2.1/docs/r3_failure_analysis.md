# R3 失败诊断报告（v2.1 落地施工）

**回归点**：R3（T10 后）
**结果**：旧链路 20/22 / 新链路 5/22
**新链路失败 case 数**：17
**判定**：禁止推进 T11，先按本报告修复，目标 ≥19/22 后再过 R3。

---

## 一、失败按根因分类（Cluster A–E）

5 个失败聚类，覆盖 17 个失败 case。每聚类含：现象 / 案例 / 根因 / 对应白皮书章节 / 涉及文件。

---

### Cluster A · 业务范围越界未 reject（5 cases）

**白皮书对应**：§5.6（TenantPolicy 作为 KernelInput 参与裁决）+ §3.2（三层规则的工程实例化：人为规则=Tenant Policy，由客户企业定义）+ §4.4（物理律之外的行为规则归 Tenant Policy）

**现象**：明显越界主张（闲聊、订餐、外送平台常识）应 reject (-1)，新链路全部 accept (1)。

**案例**：

| Case | 用户输入 | 期望 | 实得 |
|---|---|---|---|
| S1 | 今天下雪 | v=-1 | v=1 |
| S2 | 曼谷下雪了好棒 | v=-1 | v=1 |
| S6 | 订餐 / 帮我用 foodpanda 订餐 | v=-1 | v=1 |
| S7 | 订餐 3 轮 | v=-1 | v=1 |
| S20 | 用户提到外送平台（公开常识）| v=-1 | v=1 |

**根因**：

- 我的 `LIKernel.evaluateTenantPolicy` 只是占位实现，永远返回 `rejected: false`
- `ElectricCommercePolicy` 没有 `reject_claim_types` 集合
- 当用户主张是 `chitchat` / `unknown.business` 时：
  - 它们没触发任何 candidate_action（policy 模板里没有 chitchat→action）
  - 律 1 evaluate(0 个 action) → 永远 `violated: false`
  - 律 2 同理
  - Policy 评估又是空 → Kernel 直接 `accept`
- legacy preKernel 用 LLM 直判 -1（业务判断 + 关键词），新链路把这一档丢了

**违反白皮书 §5.6**：
> Kernel 不持有任何 tenant_policy
> 评估传入的 Tenant Policy（作为参数，不内置）
> if (policyResult.violated) return reject(policyResult.reason)

我实现了 if 分支但 Policy 评估函数永远不 violated。

**修复涉及文件**：
- `src/policy/TenantPolicy.ts` — 增加结构化字段：`reject_claim_types: ClaimType[]`、`out_of_scope_default: 'reject' | 'hold'`
- `src/kernel/v2_1/LIKernel.ts` — 重写 `evaluateTenantPolicy`：claim.type 在 reject_claim_types ⇒ violated；claim.type 不在 recognized_claim_types ⇒ 按 out_of_scope_default 分流
- `src/runtime/ConversationRuntime.ts` — `mapVerdictToLegacy`: reject → -1（已对，但是从未触发）

---

### Cluster B · 应 hold 收集证据但被 accept（5 cases）

**白皮书对应**：§4.1（律 1：低等级证据不能支撑高承诺度的输出）+ §5.3（ClaimExtractor 抽 claims 含 evidence_source）+ §5.6（Policy 提供 slot_definitions）

**现象**：用户提到购买/缺陷/转人工等"含承诺含义但缺槽位"的主张，应 hold (0) 收集订单号/证据，新链路 accept。

**案例**：

| Case | 用户输入 | 期望 | 实得 |
|---|---|---|---|
| S3  | 我之前买过电视机 | v=0 scope=[purchase_proof] | v=1 |
| S10 | 上月买的冰箱不制冷 | v=0 | v=1 |
| S11 | 之前买的 X9 怎么升级 | v=0 | v=1 |
| S18 | 我之前买的产品坏了，我要找人工 | v=0 (intake) | v=1 |
| S21 | 你动英文名 | v=0 (intent_clarify) | v=1 |

**根因**：
1. **purchase.assertion / defect.assertion 未触发任何 action**：
   - `ElectricCommercePolicy.candidate_action_templates` 没有"verify_purchase"或"collect_purchase_proof"模板
   - 只 `refund.request → refund.initiate`、`order.query → order.lookup`，purchase 单独没有触发器
   - 律 1 evaluate(0 个 action) → 不 violated → Kernel 默认 accept
2. **escalation.request 不带 order_id 时仍被 accept**：
   - `handoff.transfer` action 模板 `required_slots=[]` 而 `minimum_evidence_level=1`
   - 实际 S18 应 hold 收集订单号 / 投诉摘要后才能转
   - 模板缺"intake-required slots"概念
3. **meta.unclear 应触发 intent_clarify hold**：
   - 当前没有 candidate_action 模板对应 meta.unclear
   - LLM "你动英文名" 抽到 `meta.unclear` 或 `unknown.business` → 0 action → accept

**违反白皮书 §4.1**：
> 低等级证据不能支撑高承诺度的输出

工程上当用户主张 purchase/defect 但 evidence_level=1 时应 hold 追问，目前缺这个 trigger。

**修复涉及文件**：
- `src/policy/TenantPolicy.ts`：
  - 新增 `purchase.verify` action 模板（derived_from=[purchase.assertion]，required_slots=[order_id, purchase_period]，minimum_evidence_level=3）
  - 新增 `defect.collect_proof` action（derived_from=[defect.assertion]，required_slots=[order_id, defect_proof]）
  - 新增 `escalation.intake` action（derived_from=[escalation.request]，required_slots=[order_id, complaint_summary]，replaces 直接 handoff.transfer 的低门槛）
  - 新增 `intent.clarify` action（derived_from=[meta.unclear, unknown.business]，required_slots=[clarified_intent]）
- `src/kernel/v2_1/LIKernel.ts`：
  - 当律 1 evidence < required，且 required_slots 非空时 → bounds.pending_slot 设为缺失槽
- `src/runtime/ConversationRuntime.ts`：
  - `synthesizeScope` 把 hold + purchase.assertion → "purchase_proof"
  - 把 hold + escalation.request → "escalation_intake"
  - 把 hold + meta.unclear → "intent_clarify"

---

### Cluster C · 订单核验全部 wrong_shop（5 cases）

**白皮书对应**：§5.7（ActionResolver 协调外部核验）+ §4.1 等级 5 verifier_result

**现象**：所有 S13–S17 新链路 scope=["wrong_shop"]，期望各异（in_period / not_found / overdue / wrong_shop / already_returned）。

**案例**：

| Case | order_id | mock_orders 实际 | 期望 scope | 实得 scope |
|---|---|---|---|---|
| S13 | 100001 | shop_id='demo', delivered, in_period | order:100001 | wrong_shop |
| S14 | 787678 | （不存在）| order_not_found | order_not_found |
| S15 | 100002 | shop_id='demo', delivered, overdue | order_overdue | wrong_shop |
| S16 | 100005 | shop_id='other_shop' | wrong_shop | wrong_shop ← 唯一对的 |
| S17 | 100003 | shop_id='demo', returned | order_already_returned | wrong_shop |

**根因（已 verified 通过 SQL）**：
```
mock_orders.shop_id = 'demo'  （所有本店订单）
```
我的 Runtime 调用：
```ts
mockOrderVerifier.verifyByOrderId(oid, { tenant_id, shop_id: 'longma_demo' })
```
`'longma_demo' ≠ 'demo'` → MockOrderVerifier 的 classifier 判定 `belongs_to_shop=false` → classification='wrong_shop' → scope='wrong_shop'。

S14 因为 order_not_found 是更早一档判定（belongs_to_shop 不参与），所以正确——但其它的全错。

**修复涉及文件**：
- `src/runtime/ConversationRuntime.ts`：把 `shop_id: 'longma_demo'` 改成与 `mock_orders` 实际 shop_id 一致。生产期 shop_id 应来自 TenantPolicy，临时硬编码 'demo' 即可。
- 后续工程化：在 `TenantPolicy` 里增加 `default_shop_id` 字段；Runtime 从 policy 取。

---

### Cluster D · escalate (-2) 触发未生效（1 case）

**白皮书对应**：§4.2（律 2 守恒律）+ §4.4（升级阈值是律 2 的工程化推导，可调）

**现象**：S19 第 3 轮"麻烦尽快帮我处理"应 verdict=-2 触发 handoff_context 打包，新链路 v=1。

**根因**：
1. **新 Runtime 未把 should_escalate 串到 mapVerdictToLegacy**：
   - 我的 Kernel 已实现 `decision.should_escalate`，但 mapVerdictToLegacy 只检查 `verdict !== 'accept'` 时 escalate；当 verdict=accept + should_escalate=true 时映射到 1，应映射到 -2。
   - 实际 review 我的代码：`if (decision.should_escalate) return -2;` 在 mapVerdictToLegacy 早于 verdict-switch — 这一档其实有，但 ConservationLaw.evaluate 是否真的判定 should_escalate？
2. **ConservationLaw 阈值判定**：
   - 律 2 看 projection.pending_actions 累计同 action_type 数量
   - S19 三轮：T1 转人工请求 → action=handoff.transfer pending；T2 提供订单号 → action=order.lookup not_found pending；T3 加急 → action 不一定是同 type
   - 第 3 轮触发的 candidate_action 可能是 handoff.transfer 或 order.lookup —— 需要对应 type 累计 ≥ threshold(3) 才升级
   - 实际上 pending_actions 累计的是 action_type，三轮都不同 type → never reaches threshold → 永不 escalate
3. **handoff_context 三字段（user_original_complaint / verdict_trajectory / collected_verification）**：
   - 我的 Runtime 占位 verdict_trajectory=['hold','hold','escalate']（写死），不是真实历史
   - collected_verification 只有 verifier_summary，未把先前 turn 的 verifier 结果累积进来

**修复涉及文件**：
- `src/kernel/v2_1/ConservationLaw.ts`：把"不同 action_type 但都属同主题（escalation_track）"的 pending 累计逻辑加进去，或者改"任意 hold + escalation.request"作为升级触发器
- `src/runtime/ConversationRuntime.ts`：从 ledger 真实回放 verdict_trajectory；累积 verification_history

---

### Cluster E · 复合主张 scope 标签遗漏（1 case）

**白皮书对应**：§5.5（CandidatePackBuilder 把零散输入拼成 KernelInput；scope 是 legacy bridge 概念，本身不在 v2.1 核心）

**现象**：S9 "我想退货，我买的大鹅羽绒服是残次品" 期望 scope 含 `purchase_proof / product_name_clarify / product_condition_evidence`，新链路只有前 2 项，缺 `product_name_clarify`。

**根因**：
- `synthesizeScope` 只把 purchase.assertion → purchase_proof、defect.assertion → product_condition_evidence
- 当用户提到具体产品名（"大鹅羽绒服"）但 KB 没收录该品名时，旧链路会输出 `product_name_clarify` 标签暗示 LLM 追问；新 Runtime 没派生这个标签
- 这是纯 legacy bridge 映射问题，新 Runtime 内部主张是对的（refund.request + purchase.assertion + defect.assertion 都抽到了）

**修复涉及文件**：
- `src/runtime/ConversationRuntime.ts`：`synthesizeScope` 在以下条件追加 `product_name_clarify`：
  - 含 inquiry.product / purchase.assertion / defect.assertion
  - 且 evidence_pack 中对应 binding pending_evidence（KB 未命中）
  - 且 claim.content 含 `what` 或 `product_name` 字段非空
- 这一档不需要改 Kernel/Policy；纯 bridge 修补

---

## 二、按修复优先级与工程量评估

| Cluster | 失败 cases | 改文件数 | 工程量 | 修复后预期 case 通过 |
|---|---|---|---|---|
| C 订单核验 shop_id | 4 | 1 | 5 min | +4（13/15/17 + 14 已 ok） |
| A out-of-scope reject | 5 | 3 | 30 min | +5 |
| E scope 标签 | 1 | 1 | 5 min | +1 |
| B hold/intake/clarify | 5 | 3 | 60 min | +4–5 |
| D escalate threshold | 1 | 2 | 30 min | +0–1（OI-001 老问题，可能仍波动）|

**修复后 case 通过预期**：5（已过）+ 4 + 5 + 1 + 4 + 0 = **19/22**（Cluster D 不算入，作为 OI-001 留待 R3 复核）

如果 D 也修好，可达 20/22。

---

## 三、修复执行顺序

按你的要求顺序：
1. **Step 1**：Cluster C 订单核验 shop_id（5 min）→ 跑 S13–S17 验证
2. **Step 2**：Cluster A out-of-scope reject（30 min）
   - 改 TenantPolicy.ts 加 reject_claim_types
   - 改 LIKernel.ts evaluateTenantPolicy
   - → 跑 S1, S2, S6, S7, S20 验证
3. **Step 3**：Cluster B hold + intake（60 min）
   - 改 TenantPolicy.ts 加 purchase.verify / defect.collect_proof / escalation.intake / intent.clarify action 模板
   - 改 LIKernel.ts hold trigger
   - 改 Runtime synthesizeScope 增加 hold scope 标签
   - → 跑 S3, S10, S11, S18, S21 验证
4. **Step 4**：Cluster E scope 标签（5 min）→ 跑 S9 验证
5. **Step 5**：Cluster D escalate（30 min，可选）→ 跑 S19 验证
6. **最终**：跑全量 S1–S22 + 失败对话重放，目标 ≥19/22。

每步修完立刻跑对应 case 子集，不等全部修完才跑。

---

## 四、根本原因（meta-cause）

**前 9 个 Task 单元测试全过，R3 端到端 5/22 —— 因为单元测试只验证组件孤立行为，没验证组件协同**。

具体证据：
- T6 Kernel 单测验证"hold/accept/reject 各档可达"，但没验证"chitchat 输入 → reject"
- T7 ActionResolver 单测验证"同 action_id hash 稳定"，但没验证"verifier shop_id 与 mock_orders 对齐"
- T8/T9 generator/auditor 单测验证 bounds 内输出，但没验证完整 chat/lios 调用链

**整改**：本份报告完成后，更新 `docs/v2_1_open_issues.md` 加 OI-003：
> 未来 Task 完成的"验收标准"必须包含至少一个端到端集成测试——
> 真实从 chat 入口走到 reply 出口，校验 verdict + scope + reply 三项一致。
> 不能只有单元测试。

这是预防 R3 翻车的工程纪律。

---

## 五、待用户确认

报告完成。等你看完后允许进入修复阶段（按上面 Step 1–5 顺序）。

修复期间不再写新组件、不再做 v2.1 之外的设计变更——只针对本报告 5 个 Cluster 改最少代码达到 ≥19/22。

预算：你给我 4–5h，我尽量在 2h 内做完，超时停下汇报。
