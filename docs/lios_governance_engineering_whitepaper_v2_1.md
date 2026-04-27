# LIOS 治理工程化白皮书 v2.1（稳定运行版）

**版本说明**：v2.1 在 v2 基础上完成 6 项工程稳定性修正：
1. 关键词规则退场范围精确化（业务语义关键词退场，工程确定性规则保留）
2. 元主张（meta-claim）纳入 ClaimExtractor
3. ConversationRuntime 实体保留，仅作废硬编码 phase 状态机
4. Tenant Policy 作为输入参与裁决，不固化进 Kernel 内核
5. BoundsAuditor 升级为三层审核机制
6. Action ID 生成规则与幂等范围明确化

---

## 第一节：LIOS 母理念（原话保留）

### 1.1 核心原理

> 规则是底线，底线之上天高地厚任人驰骋。

### 1.2 设计目标

> 在治理框架下，我们运行 LLM 自由发挥，这样才不至于出现一抓就死一放就飞的不平衡的现象。

### 1.3 三层结构（企业即星球）

> 每个企业就是一个星球，在这个星球里，都有人为的规则和自然物理规则，人民在此之上才是自由的开始。

### 1.4 产品定位

> LI Kernel 治理是核心，也是我们区别于目前市面上所有数字人的核心能力，实现对各行各业数字人经常出现的致幻、目标漂移、嘴炮等问题的治理。抛弃靠关键词规则来解决这些问题的方式。

---

## 第二节：v2.1 核心修正纲要

LIOS 不采用关键词驱动的业务判断，也不把所有判断交给 LLM 自由决定。

LIOS 的工程原则是：

1. 业务语义理解交给 ClaimExtractor
2. 状态连续性由 ConversationRuntime 负责
3. 当前会话状态由 Ledger 派生出的 ConversationProjection 提供
4. 两条物理律由 LI Kernel 固化执行
5. Tenant Policy 作为外部输入参与裁决，不进入 Kernel 内核
6. ActionResolver 通过 Action ID 与 Ledger 实现幂等守恒
7. LLM 只在 Bounds 内生成自然语言
8. BoundsAuditor 采用结构化校验 + 语义审核 + 兜底模板三层机制

**关键词规则退场，不代表确定性规则退场。退场的是"用关键词替代语义理解"的旧范式；保留的是"用结构化约束保证系统可治理"的工程纪律。**

---

## 第三节：理念到工程的映射

### 3.1 LLM 角色精确表述

> LLM 在治理边界内求解自然语言的最优措辞。其创造性完全体现在"如何表达"，而非"表达什么"。

工程文档使用"约束下的最优语言生成"（governed language generation）。"自由发挥"仅在对外宣传中保留。

### 3.2 三层规则的工程实例化

| 理念层 | 工程实例 | 谁定义 | 修改频率 |
|---|---|---|---|
| 自然物理规则 | LI Kernel 内置两条物理律 | LIOS 团队 | 永不变 |
| 人为规则 | Tenant Policy（外部输入） | 客户企业 | 按业务演化 |
| 约束下的最优语言生成 | LLM 在 bounds 内生成 | 涌现 | 每次都不同 |

### 3.3 关键词规则的精确退场范围

**这是 v2.1 最重要的修正之一**。

**业务语义关键词规则——退场**：
| 退场项 | 替代方案 |
|---|---|
| `is_pure_affirmation`（"是/对/正确"列表） | ClaimExtractor 抽取 meta.confirmation |
| `detect_order_source`（"shopee/lazada"列表） | LLM 语义抽取 order_source 主张 |
| `escalation_repeat_regex`（正则匹配「聯繫人工客服」） | ClaimExtractor 抽取 escalation_request 主张 + ActionResolver 查账本 |
| `commitment_keyword_block`（关键词拦截「為您處理」） | BoundsAuditor 第二层语义审核 |
| `not_found_variant_block`（6 种变体正则） | BoundsAuditor 第一层结构化校验 + bounds.must_not |
| `phase_required_slots_writeoff`（写死必填槽） | TenantPolicy 配置 + ConversationProjection 推导 |

**工程确定性规则——保留并强化**：
| 保留项 | 类型 | 必要性 |
|---|---|---|
| escalated 终态守卫 | 状态守卫规则 | 律 2 的工程实现 |
| Action ID 幂等去重 | 结构校验规则 | 律 2 的工程实现 |
| JSON Schema 校验 | 结构校验规则 | 数据契约稳定性 |
| 字段类型校验 | 结构校验规则 | 防数据污染 |
| 禁止承诺已退款 / 虚构订单 | 安全边界规则 | 律 1 的工程实现 |
| Bounds 必含字段校验 | 结构校验规则 | BoundsAuditor 第一层 |

| 类型 | 是否保留 | 说明 |
|---|---|---|
| 业务关键词判断 | ❌ 不保留 | "看到 shopee 就自动判断"这种规则退场 |
| 状态守卫规则 | ✅ 必须保留 | escalated 后不可重复转人工 |
| 结构校验规则 | ✅ 必须保留 | JSON schema、字段类型、Action ID 去重 |
| 安全边界规则 | ✅ 必须保留 | 禁止承诺已退款、禁止虚构订单 |

**关键认识**：业务语义关键词是"用低级手段替代语义理解"——退场。工程确定性规则是"用结构化约束保证系统可治理"——必须保留。两者性质完全不同，不可混淆。

---

## 第四节：两条物理律

### 4.1 律 1：证据闭合律（Evidence Closure）

> **任何 AI 对外的事实性陈述必须可追溯到证据来源。无证据即无输出。**

证据来源等级（从弱到强）：
1. user_assertion（用户口述）
2. system_observation（系统观察）
3. ledger_record（账本历史）
4. kb_lookup（KB 命中）
5. verifier_result（外部系统核验）

**律的执行**：
- 低等级证据不能支撑高承诺度的输出
- 用户口述不能支撑"为您办理"这类承诺
- KB 未命中时，AI 必须明确声明"系统未记录"，不可凭空补充

**治理的病**：致幻、嘴炮。

### 4.2 律 2：账本守恒律（Ledger Conservation）

> **已 committed 的 Action 不被重复触发。系统状态由不可篡改的账本独一定义。**

**律的执行**：
- 账本是状态的唯一真相源
- 任何决策前先查账本：是否对应已 committed 的 Action？
- 已 committed → 直接返回引用，不生成新 Action
- 未 committed → 走完整流程后写账本

**治理的病**：目标漂移、重复执行、状态污染。

### 4.3 物理律归约表

| 候选律 | 实际归属 | 归约逻辑 |
|---|---|---|
| 证据律 | **保留为律 1** | 基础律，不可归约 |
| 守恒律 | **保留为律 2** | 基础律，不可归约 |
| 核验律 | 归入律 1 | 核验失败 = 证据不足 |
| 升级律 | 归入律 2 | 同一 Action 反复 pending 触发升级 |
| 终结律 | 归入律 2 | 已写入最终决议的 Action 不可再生 |

### 4.4 物理律之外的行为规则——降级为推导规则

核验、重试、升级、终态封锁这些具体行为，**不是物理律，是物理律的工程化推导**：

```
物理律（不可变）
    ↓ 推导
Runtime 状态转移规则（可调整阈值）
    ↓ 表现
具体对话行为
```

阈值可调（"事不过三"是默认值），物理律本身不变。

---

## 第五节：技术架构

### 5.1 总体数据流

```
用户输入
  ↓
ConversationRuntime（保留实体，仅废除硬编码 phase 状态机）
  ↓
读取 Ledger
  ↓
构建 ConversationProjection（派生视图，只读）
  ↓
ClaimExtractor 抽取 claims + meta_claims
  ↓
EvidenceBinder 绑定证据
  ↓
CandidatePackBuilder 构造候选动作 + 注入 Tenant Policy
  ↓
LI Kernel 执行两条物理律 + 评估传入的 Tenant Policy
  ↓
ActionResolver 查账本，按 Action ID 实现幂等
  ↓
BoundedLLMGenerator 生成回复
  ↓
BoundsAuditor 三层审核（结构化 + 语义 + 兜底模板）
  ↓
写入 Ledger
  ↓
回复用户
```

### 5.2 ConversationRuntime（保留实体）

**v2.1 重要修正**：作废的是硬编码 phase 状态机，**不是 ConversationRuntime**。

ConversationRuntime 仍是 LIOS 多轮治理的执行中枢，职责：

```typescript
class ConversationRuntime {
  async handle(userInput: string): Promise<RuntimeAction> {
    // 1. 读取 Ledger 最新状态
    const ledgerSummary = await this.ledger.summarize(this.conversation_id)
    
    // 2. 构建 ConversationProjection（从账本重算）
    const projection = await this.buildProjection(ledgerSummary)
    
    // 3. 调 ClaimExtractor（含 meta.confirmation 抽取）
    const claims = await this.claimExtractor.extract(userInput, projection)
    
    // 4. 调 EvidenceBinder
    const evidencePack = await this.evidenceBinder.bind(claims)
    
    // 5. 构造 CandidatePack 含 Tenant Policy
    const pack = this.candidatePackBuilder.build(claims, evidencePack, projection, this.tenantPolicy)
    
    // 6. LI Kernel 裁决
    const decision = await this.kernel.decide(pack)
    
    // 7. ActionResolver 查账本守恒
    const action = await this.actionResolver.resolve(decision, this.ledger)
    if (action.alreadyCommitted) {
      return this.replyWithReference(action)
    }
    
    // 8. BoundedLLMGenerator 生成
    const reply = await this.llmGenerator.generate(decision.bounds, ledgerSummary)
    
    // 9. BoundsAuditor 三层审核
    const audited = await this.boundsAuditor.audit(reply, decision.bounds)
    
    // 10. 写 Ledger
    await this.ledger.commit({ userInput, claims, decision, action, audited })
    
    return audited
  }
}
```

**关键**：phase / pending_slots 不再写死在代码，而是从 ConversationProjection 推导。

### 5.3 ClaimExtractor（含元主张）

**v2.1 重要修正**：用户的"正确""嗯""好的"等不再输出空数组，而是抽取为 **meta.confirmation** 主张。

主张类型分两层：

**业务主张（business claims）**：
```typescript
{
  type: "refund.request",
  content: { reason: "..." },
  evidence_source: "user_assertion",
  confidence: 0.92
}
```

**元主张（meta claims）**：
```typescript
{
  type: "meta.confirmation",
  target: "previous_system_question",   // 指向上一轮系统等待的 slot/action
  content: { confirmed: true },
  evidence_source: "user_assertion",
  confidence: 0.86
}

{
  type: "meta.negation",
  target: "previous_system_question",
  content: { confirmed: false },
  ...
}

{
  type: "meta.unclear",   // 用户输入完全无法解析
  ...
}
```

**绑定逻辑**：
```
用户说"正确"
    ↓
ClaimExtractor 抽取 meta.confirmation
    ↓
ConversationProjection 找出上一轮 AI 在等什么（pending_slot / pending_action）
    ↓
Runtime 把 confirmation 绑定到对应 pending 项
    ↓
对应项被标记为 confirmed，进入下一轮处理
```

**这就解决了"用户说'正确'5 次 AI 5 次重复追问"的问题**——不靠关键词列表，靠语义结构化 + 上下文绑定。

### 5.4 EvidenceBinder

执行律 1。每条主张必须有 evidence_source。无证据的主张被标记为 `pending_evidence`，进入 hold 池。

### 5.5 CandidatePackBuilder

把"主张 + 证据 + 候选 Action + 租户策略 + 账本摘要"拼成标准 KernelInput：

```typescript
type KernelInput = {
  claims: Claim[]
  evidence_pack: EvidencePack
  candidate_actions: CandidateAction[]
  tenant_policy: TenantPolicy        // 作为输入，不固化进 Kernel
  ledger_summary: LedgerSummary
}
```

### 5.6 LI Kernel（v2.1 重要修正）

**纯净性原则**：Kernel 内核只内置两条物理律。Tenant Policy **作为输入参数传入**，由 Kernel 在本轮裁决中评估，**不固化进 Kernel**。

```typescript
class LIKernel {
  // 内置：两条物理律
  private readonly law1_evidenceClosure: EvidenceLaw
  private readonly law2_ledgerConservation: ConservationLaw
  
  // Kernel 不持有任何 tenant_policy
  
  decide(input: KernelInput): Decision {
    // 1. 律 1 评估
    const law1Result = this.law1_evidenceClosure.evaluate(input.claims, input.evidence_pack)
    if (law1Result.violated) return hold(law1Result.reason)
    
    // 2. 律 2 评估
    const law2Result = this.law2_ledgerConservation.evaluate(input.candidate_actions, input.ledger_summary)
    if (law2Result.violated) return law2Result.referenceExisting()
    
    // 3. 评估传入的 Tenant Policy（作为参数，不内置）
    const policyResult = this.evaluateTenantPolicy(input.tenant_policy, input)
    if (policyResult.violated) return reject(policyResult.reason)
    
    // 4. 输出 Decision + Bounds
    return accept({
      bounds: this.deriveBounds(input, policyResult),
      ...
    })
  }
}
```

**这样不同租户的不同 policy，由同一个 Kernel 实例评估，Kernel 本身保持单一可信**。

### 5.7 ActionResolver（v2.1 重要修正）

**Action ID 生成规则**：

```typescript
type ActionIdInput = {
  tenant_id: string
  conversation_id: string
  action_type: string
  normalized_claims: any[]            // 标准化后的主张内容
  target_object_id?: string           // 如 order_id
  idempotency_scope: IdempotencyScope
}

function generateActionId(input: ActionIdInput): string {
  return hash({
    tenant: input.tenant_id,
    scope: input.idempotency_scope,
    type: input.action_type,
    target: input.target_object_id,
    claims: normalize(input.normalized_claims)
  })
}
```

**幂等范围按 Action 类型不同**：

| Action 类型 | idempotency_scope | 含义 |
|---|---|---|
| 转人工 | conversation | 同一会话只能转一次 |
| 查询订单 | order_id + channel | 同一订单同一渠道只查一次（缓存） |
| 申请退款 | order_id + refund_reason | 同订单同原因只申请一次 |
| 领取优惠券 | user_id + coupon_id | 同用户同券只领一次 |
| 修改用户资料 | user_id + field_name | 同用户同字段只改一次 |
| 普通咨询答复 | user_input_hash + conversation | 同问题同会话只答一次 |

**反例**：
- 范围太宽（全 tenant 级别）：用户在不同会话发起独立任务被错误拦截
- 范围太窄（每条消息独立）：用户重复点击仍触发多次动作

ActionResolver 工作流：
```
1. 接收 Decision + 候选 Action
2. 按 Action 类型选 idempotency_scope
3. 生成 action_id
4. 查 Ledger：is_committed(action_id)?
5. 已提交 → 返回 { alreadyCommitted: true, reference: existing }
6. 未提交 → 占位 pending → 走完整流程
```

### 5.8 BoundedLLMGenerator

LLM 在 bounds 内做约束下的最优语言生成。

bounds 包含：
- `must`：必须做到的事
- `must_not`：不可违反的事
- `may`：建议但非强制

LLM 自由组织措辞、语气、节奏，**只要不违反 bounds**。

### 5.9 BoundsAuditor 三层审核（v2.1 重要修正）

**这是 v2.1 关键修正**。不能让 Auditor 自己变成"会漂移的 LLM"。三层结构：

#### 第一层：结构化校验（确定性，必过）

```typescript
function structuralAudit(reply: string, bounds: Bounds): AuditResult {
  // 1. 是否包含 must 字段要求的关键内容（结构化标签校验）
  for (const requirement of bounds.must) {
    if (!matchesStructuralRequirement(reply, requirement)) {
      return { passed: false, layer: 'structural', reason: 'must_missing' }
    }
  }
  
  // 2. 是否输出了 must_not 中标注为高风险的承诺标签
  for (const prohibition of bounds.must_not_structural) {
    if (matchesStructuralPattern(reply, prohibition)) {
      return { passed: false, layer: 'structural', reason: 'must_not_violated' }
    }
  }
  
  // 3. 禁止字段（如 token、credit_card）出现校验
  if (containsForbiddenFields(reply)) {
    return { passed: false, layer: 'structural', reason: 'forbidden_field' }
  }
  
  return { passed: true, layer: 'structural' }
}
```

#### 第二层：语义审核（AI 模型，作为补充）

```typescript
async function semanticAudit(reply: string, bounds: Bounds, decision: Decision): AuditResult {
  // 1. 是否承认了不存在的事实（基于 decision.evidence_status 判断）
  // 2. 是否承诺了无法执行的动作
  // 用小模型 / 嵌入相似度做语义判断
  // 仅作为第一层的补充，不作为唯一依据
}
```

#### 第三层：失败兜底（确定性，最后防线）

```typescript
function fallbackTemplate(decision: Decision): string {
  // 审核失败 → 重试一次
  // 仍失败 → 使用 verdict-specific 固定模板
  switch (decision.verdict) {
    case 'accept': return TEMPLATES.acceptFallback
    case 'hold': return TEMPLATES.holdFallback
    case 'reject': return TEMPLATES.rejectFallback
  }
}
```

**审核流程**：
```
LLM 输出
  ↓
第一层结构化校验
  ├─ 通过 → 第二层语义审核
  │           ├─ 通过 → 输出
  │           └─ 失败 → retry 一次 → 仍失败 → 第三层兜底
  └─ 失败 → retry 一次 → 仍失败 → 第三层兜底
```

**确定性优先、AI 补充、模板收口**——这是治理系统的正确审核范式。

### 5.10 Ledger（不可篡改的真相源）

所有用户输入、主张抽取结果、证据绑定、Kernel 决定、bounds、LLM 输出、Action 状态变化都进账本。

**会话状态从账本计算得出**（详见第六节）。

---

## 第六节：派生视图与真相源原则

### 6.1 矛盾的存在

理念上，账本是状态的唯一真相源。
工程上，每轮重算账本会带来延迟。

### 6.2 解决方案：ConversationProjection

允许在 Runtime 中维护**完全从账本重算的、只读的派生视图**：

```typescript
type ConversationProjection = {
  conversation_id: string
  
  // 从账本计算
  inferred_phase: string              // 推导值，不是字段
  pending_slots: Slot[]
  filled_slots: Slot[]
  pending_actions: Action[]
  attempts: Record<string, Attempt>
  verification_history: any[]
  last_system_question?: {            // 用于 meta.confirmation 绑定
    target_slot?: string
    target_action?: string
  }
  
  // 元数据
  computed_from_ledger_seq: number
  computed_at: number
}
```

**生命周期**：
- 会话加载时从账本重建
- 本轮使用投影加速判断
- 账本写入新记录后，投影同步更新（或下次加载重建）
- 派生视图随时可销毁，从账本可完全重建

### 6.3 派生视图不可写原则（Read-Only Projection Principle）

**架构纪律**：

> **派生视图绝不成为第二真相源。派生视图绝不可独立写入。任何状态变化必须先写账本，再触发投影更新。**

实施约束：
- 投影对象 readonly
- 任何修改投影的代码路径必须先经账本写入接口
- 投影更新只接受"从账本重算"或"账本新增记录后增量更新"
- 测试必须验证：销毁投影后从账本重建结果一致

### 6.4 务实的纯粹主义

原则一步不退，实现允许降本增效，但降本手段必须可重建、不可独立写。

---

## 第七节：跨行业通用性

### 7.1 精确表述

> LIOS 治理管线（Runtime + Kernel + Ledger）在客服、法律、医疗、教育等行业高度复用，构成普世信任引擎。行业语义管线（意图解析、槽位定义、证据抽取模型）可根据行业需求配置、替换或增强，而不打破治理边界。

### 7.2 区分

**跨行业不变（普世信任引擎）**：
- 两条物理律
- LI Kernel 三态裁决
- ActionResolver 账本查询逻辑
- BoundedLLMGenerator + BoundsAuditor 三层审核
- Ledger 数据模型
- ConversationRuntime 主控

**跨行业可变（行业语义管线）**：
- 可识别的主张类型集（含元主张和业务主张）
- 槽位定义（每个意图需要哪些必填信息）
- 证据抽取的具体模型
- KB 内容
- 租户策略

### 7.3 落地策略

- **优先纯配置路线**：先尝试通过配置适配新行业
- **配置不够再考虑加装**：允许在 ClaimExtractor 层"加装"专有模型，治理管线保持不变
- **避免过早特化**：先确定上限再考虑下限

---

## 第八节：当前代码资产盘点

**保留**：
- LI Kernel 三态判定接口
- KB / Asset 系统
- OrderVerifier 抽象层
- ChannelAdapter 抽象层
- Ledger 基础设施
- **ConversationRuntime 实体**（v2.1 修正）

**重构**：
- preKernel → 拆分为 ClaimExtractor（含元主张） + EvidenceBinder + CandidatePackBuilder
- promptBuilder → 改为 BoundedLLMGenerator
- postAudit → 改为 BoundsAuditor 三层审核

**作废**：
- 之前那份 ConversationRuntime 冻结稿中的**硬编码 phase 状态机**（v2.1 修正：实体保留，仅作废硬编码部分）
- 业务语义关键词列表

**新增**：
- ConversationProjection（含不可写原则的代码层强制）
- ActionResolver（含明确的 Action ID 生成规则）
- 元主张抽取能力（ClaimExtractor 内）

---

## 第九节：实施分阶段

**阶段 A：理念与白皮书锁定**（已完成 v2.1）

**阶段 B：核心管线落地**
1. ConversationProjection（含不可写原则）
2. ClaimExtractor（含 meta.confirmation / meta.negation / meta.unclear）
3. EvidenceBinder（执行律 1）
4. CandidatePackBuilder（注入 TenantPolicy）
5. LI Kernel（内置两条物理律 + 评估传入 policy）
6. ActionResolver（含明确 Action ID 规则）
7. BoundedLLMGenerator
8. BoundsAuditor（三层审核）
9. ConversationRuntime 主控（重写）
10. Ledger 增强

**阶段 C：客服 demo 适配**
- 写电商租户 policy
- 配置主张类型集（业务 + 元主张）
- 跑那段失败对话回归
- 跑现有 22 个对抗 case 回归

**阶段 D：跨行业验证**
- 写第二个租户 policy（医疗 / 法律 / 教育任选其一）
- 验证治理管线不动情况下能否适配

---

## 第十节：自检——本稿是否忠实于母理念

| 母理念 | 本稿对应 | 是否忠实 |
|---|---|---|
| 规则是底线，底线之上自由发挥 | 三层架构 + bounds 机制 | ✅ |
| 一抓就死一放就飞要平衡 | 关键词业务规则退场 + 工程确定性规则保留 + bounds | ✅ |
| 企业即星球 | TenantPolicy 在 Kernel 之外，作为输入参与裁决 | ✅ |
| LI Kernel 是核心 | 两条物理律内置，policy 不固化 | ✅ |
| 抛弃关键词规则 | 业务关键词退场，工程确定性规则保留 | ✅ |
| 治理致幻/漂移/嘴炮 | 律 1 + 律 2 + 三层审核 | ✅ |
| 各行各业通用 | 治理管线普世，行业语义管线可配置 | ✅ |

---

## 附录：v2 → v2.1 修订对照

| 修订点 | v2 | v2.1 |
|---|---|---|
| 关键词退场 | 全面退场 | 业务关键词退场，工程确定性规则保留 |
| 元主张 | "正确"输出空数组 | meta.confirmation 抽取并绑定上下文 |
| ConversationRuntime | 措辞含糊（易误读为作废） | 实体保留，仅作废硬编码 phase 状态机 |
| Tenant Policy | "Kernel 执行 Policy" | Policy 作为 KernelInput 传入，不固化 |
| BoundsAuditor | 单层语义分类器 | 三层（结构化 + 语义 + 兜底模板） |
| Action ID | 抽象表述 | 明确生成规则 + 按类型的 idempotency_scope |
