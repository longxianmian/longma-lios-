# LIOS v2.2 功能与集成说明(用户视角)

**版本**: v0.1
**生成日期**: 2026-04-28(LIOS v2.2 完工当日)
**目标读者**: 龙先冕 + 未来接入 LIOS 的产品工程师
**特点**: 用大白话讲,不用工程术语;看完一遍就知道"LIOS 是什么 + 怎么用"

---

## 第一部分:LIOS v2.2 是什么

### 1.1 一句话说清楚

> LIOS 是**给 AI 装上"边界 + 规则 + 决策记录"的中间层**。
>
> 你的产品(标典 / 天问 / 问问 / City One)调 LIOS,把"用户输入 + 我们想让 AI 做什么"丢给 LIOS,LIOS 返回"该不该做 / 怎么做 / 拒绝就拒绝",并把整个决策过程**留下可审计的证据**。

### 1.2 不用 LIOS 会怎样,用了 LIOS 会怎样

**不用 LIOS 的情况(常见做法)**:

```
用户 → 你的产品 → 直接调 OpenAI/Claude API → 返回结果给用户
```

问题:
- AI 想说啥说啥,可能瞎承诺(标典里 AI 答应客户"包中标"——惨案)
- 跨用户/跨租户没隔离(标典 A 客户的数据可能被生成给 B 客户看)
- 出问题了你不知道哪里出的(没有决策过程的可审计记录)
- 业务规则改一次,要在代码里到处改 prompt

**用 LIOS 的情况**:

```
用户 → 你的产品 → LIOS(规则裁决) → 你的产品(执行) → 返回结果
                    ↓
                 决策证据留档
```

好处:
- AI 受规则约束(LIOS 里写好"哪些话不能说""哪些动作不能做")
- 跨租户物理隔离(标典 A 永远只能看 A 自己的数据,token 层强制)
- 每个决策有审计记录(出问题能追溯)
- 业务规则在 LIOS 一处定义,产品代码不用改

### 1.3 LIOS 跟 OpenAI / Claude 是什么关系

**LIOS 不是 LLM 替代品**。

- OpenAI / Claude:**生成内容**(LLM)
- LIOS:**约束 LLM 该怎么生成 + 该不该让它生成**(治理层)

LIOS 内部**调用** LLM(Claude API),但 LIOS 的核心是**LLM 之外的那一层规则**。

类比:
- LLM = 厨师(会做饭)
- LIOS = 餐厅经理(决定厨师能做什么菜、不能做什么、什么时候上菜、客人投诉怎么处理)
- 你的产品 = 餐厅前台(接客人订单,问经理"这单能做吗",经理说"能做这样"才让厨师做)

---

## 第二部分:LIOS v2.2 当前能干什么(功能清单)

### 2.1 核心功能(到 v2.2 完工时已经实现)

| 功能 | 通俗说法 | 谁用 |
|---|---|---|
| **多租户隔离** | 不同产品 / 不同客户的数据**物理上**绝对不串 | 所有产品应用 |
| **API 访问授权** | 调 LIOS 必须带 token,token 绑死 (产品, 租户) | 所有产品应用 |
| **租户 policy 定义** | 每个租户可以有自己的业务规则(claim_types / forbidden_commitments / bounds_template 等)| 标典 / 天问等 |
| **声明抽取(Claim Extraction)** | LIOS 把用户输入 → 结构化 claims(知道用户在说什么)| LIOS 内部 |
| **候选动作生成(Candidate Pack)** | LIOS 列出"可能的动作清单",再让 LLM 选 | LIOS 内部 |
| **边界裁决(Bounds Auditor)** | LLM 输出违反规则 → LIOS 直接拒掉 | LIOS 内部 |
| **决策日志(Trace Ledger)** | 每个决策从输入到输出全过程留档,可审计 | 排查问题 / 合规 |
| **Verdict 三态** | accept(通过)/ reject(拒绝)/ hold(挂起人工)| 产品逻辑分支 |

### 2.2 v2.2 比 v2.1 多了什么

v2.1 是**单租户系统**(只能给一个客户用)。
v2.2 是**多租户平台**:

| 改动 | v2.1 | v2.2 |
|---|---|---|
| tenant 注册 | 代码里硬编码 3 个 | 数据库里登记,产品应用按需注册 |
| 调用授权 | 没有 / 简单 | token 必填 + token 绑 (tenant, source_app) |
| 跨租户隔离 | 没有 | 物理外键 + token 验证双重保障 |
| policy 加载 | 启动时硬编码 | 启动时从 DB 加载,改 policy 不用改代码 |

**意义**:v2.2 之后,你**可以同时跑多个产品应用**(标典 + 天问 + 问问 + City One),每个产品自己的客户 / 数据 / 规则**互相隔离**,共享底层 LIOS 内核。这是龙码 SaaS 商业模式的**工程基础**。

### 2.3 v2.2 还**没有**什么(诚实说清楚)

避免你产生不切实际的预期:

| 没有 | 后续阶段会补 |
|---|---|
| 真实业务规则(标典/天问 policy 是占位骨架,不是真业务规则)| 标典 P0 / 天问 P0 |
| 后台管理界面(给 token / 注册租户都要 SQL 手工)| 后续工程 |
| 计费 / 配额(每个 tenant 调多少次有没有限制)| 后续工程 |
| HTTP 错误语义优化(tenant 不存在返 500 不是 400)| OI-γ-001(低优 OI)|
| 完整白皮书 | OI-δ-001(待补)|

---

## 第三部分:产品应用怎么用 LIOS(集成指南)

### 3.1 接入流程(假设要让标典接 LIOS)

**Step 1:在 LIOS 数据库给标典注册商户身份**

```sql
INSERT INTO lios_tenants (
  tenant_id, company_name, contact_name, email, password_hash, ...
) VALUES (
  'biaodian-prod', '龙码标典 SaaS', '运营负责人', 
  'ops@biaodian.longma.com', '<bcrypt hash>', ...
);
```

(未来后台管理系统会有界面,目前 SQL 手工)

**Step 2:给标典写真实的 policy(替换 γ-4 占位骨架)**

新建 `src/policy/policies/biaodian_real.ts`(γ-4 留下的 `biaodian.ts` 是占位骨架,标典 P0 时替换):

```typescript
export const BiaodianRealPolicy: TenantPolicy = Object.freeze({
  tenant_id: 'biaodian-prod',
  industry: 'biaodian',
  recognized_claim_types: [
    'biaodian.tender_query',     // 客户问招投标
    'biaodian.qualification',    // 客户问资质
    'biaodian.deadline',         // 客户问截止日期
    // ... 标典 P0 阶段定义的真实业务 claim 类型
  ],
  candidate_action_templates: [
    // 标典真实候选动作:查招标库 / 查资质库 / 提醒截止 ...
  ],
  forbidden_commitments: [
    'guarantee_winning',         // 不准承诺中标
    'leak_competitor_bid',       // 不准泄露竞品报价
    // ...
  ],
  bounds_template: {
    must:     ['cite_source', 'use_zh_CN', 'respect_evidence_law'],
    must_not: ['fabricate_facts', 'commit_unverified', 'leak_internal_terms'],
    may:      ['suggest_consultation'],
  },
  // ... 其他字段
});
```

**Step 3:在 LIOS 的 policyById map 里注册标典真实 policy**

```typescript
// src/policy/policies/index.ts
export const policyById = Object.freeze({
  electric_commerce: ElectricCommercePolicy,
  healthcare:        HealthcareConsultPolicy,
  tianwen:           TianwenPolicy,
  biaodian:          BiaodianRealPolicy,  // ← 替换 γ-4 占位
});
```

**Step 4:在 lios_tenant_policies 给标典 tenant 绑定 policy**

```sql
INSERT INTO lios_tenant_policies (tenant_id, policy_id) VALUES
  ('biaodian-prod', 'biaodian');
```

**Step 5:给标典发一个 LIOS API token**

```sql
INSERT INTO lios_access_tokens (token, tenant_id, source_app) VALUES
  ('<生产 token, 由后台管理生成>', 'biaodian-prod', 'biaodian');
```

**Step 6:重启 LIOS 服务,新租户立即生效**

启动日志:
```
✅ loaded 4 tenant policies from DB: [demo, tianwen-demo, biaodian-demo, biaodian-prod]
```

**Step 7:标典 SaaS 调 LIOS API**

```bash
curl -X POST https://lios.longma.com/lios/runtime/decide \
  -H "Authorization: Bearer <标典生产 token>" \
  -H "Content-Type: application/json" \
  -d '{
    "tenant_id": "biaodian-prod",
    "source_app": "biaodian",
    "user_message": "帮我查一下国家电网最新一期的智能电表招标公告",
    "conversation_id": "...",
    "trace_id": "..."
  }'
```

**LIOS 返回**:
```json
{
  "verdict": "accept",
  "verdict_legacy": 1,
  "reply": "我查到 2026-Q2 国家电网智能电表招标公告,投标截止 ...",
  "evidence": [...],
  "trace_id": "..."
}
```

或者(违反规则的请求):
```json
{
  "verdict": "reject",
  "reply": "抱歉,我无法保证客户中标。我可以帮您分析往期中标规律,提供投标策略建议。"
}
```

### 3.2 集成时产品工程师要做的工程量

| 工作 | 工程量 |
|---|---|
| HTTP 客户端调 `/lios/runtime/decide` | ~50 行代码 |
| 解析 verdict 三态做产品逻辑分支 | ~30 行代码 |
| token 配置(从环境变量读)| ~5 行代码 |
| 决策证据落自己 DB(可选,LIOS 内部已有 trace ledger)| ~50 行代码 |

**对比"自己写治理规则代码"**:
- 治理规则代码大概要写 2000-5000 行(claim 抽取 + 候选生成 + 规则裁决 + 证据校验)
- 接 LIOS = 复用所有这些规则,产品代码省 95%+ 的治理逻辑

### 3.3 LIOS 给产品的 3 种 Verdict 怎么处理

| Verdict | 含义 | 产品该怎么办 |
|---|---|---|
| **accept** | 通过,LIOS 给了 reply,可以直接给用户 | 把 reply 显示给用户 |
| **reject** | 违反规则,LIOS 给了拒绝 reply(委婉的拒绝词)| 把拒绝 reply 显示给用户,产品**不要**自己再加内容 |
| **hold** | LIOS 不确定,挂起待人工 | 显示"正在为您处理,请稍候" + 转人工 / 产品内部审核流程 |

---

## 第四部分:LIOS v2.2 在龙码体系里的位置

### 4.1 龙码三层架构图

```
                 龙码协议 (思想总纲)
                        │
        ┌───────────────┴────────────────┐
        │                                │
    基础设施层                       产品应用层
    ┌────┴─────┐                ┌────────┴────────┐
    │          │                │                 │
  LIOS    信息资产化      标典   天问   问问   City One
  (做决策) (做记账)       (用 LIOS + 资产化)
```

### 4.2 LIOS 跟资产化的关系

**LIOS 和资产化是并列的两个基础设施,互不消费**(交接书 §2 锁定):

- **LIOS** 解决:决策怎么做、规则怎么守、证据怎么留
- **信息资产化** 解决:数据 / 知识怎么登记成资产、资产怎么流转、资产怎么定价

它们**协作但不依赖**:
- 标典调 LIOS 做决策,同时调资产化登记数据资产
- 资产化系统**自己**不调 LIOS API(它是同层基础设施,不是消费方)

### 4.3 接下来 30 周的工程顺序

```
今天 (4-28):  ✅ LIOS v2.2 完工
明天 (4-29):  ⏸ 启动龙码信息资产化系统 P0 (16 周, 8月底完工)
~9月初:       ⏸ 启动标典 P0 (12-16 周, 12月底完工)
```

### 4.4 标典 P0 阶段会做什么

(让你提前对未来工程有概念)

标典 P0 不需要重做 LIOS,只做"标典自己的产品代码":

1. 替换 γ-4 占位 policy 为标典真实业务规则(招投标领域知识)
2. 写标典 SaaS 前端(给客户看的界面)
3. 写标典 SaaS 后端(对接 LIOS + 资产化)
4. 写标典数据采集(招标公告 / 资质库等)
5. 写标典计费 + 用户管理

工程量大头在 **2/3/4/5**(标典自己的产品),LIOS 接入只占 **1**(替换 policy + Step 1-7 接入流程)。

---

## 第五部分:你作为创始人,看完应该知道什么

### 5.1 LIOS v2.2 给你的"杠杆"

- **一套 LIOS 内核** + **多个产品应用** = 龙码 SaaS 商业模式
- 每多接一个产品应用,只需要**写产品 policy** + **接 LIOS API**,不用重写治理逻辑
- 产品应用之间**物理隔离**,数据安全有工程保障

### 5.2 你今天交付的东西**真实价值**

1. **物理证据**:13 个 commit + 4 个 tag + OTS 区块链锚定 → 工程交付不可抵赖
2. **可演进基础**:γ-4 占位 policy 留好了"标典 / 天问"的槽位,标典 P0 直接替换内容,LIOS 内核不用改
3. **协作链验证**:你 + 蓝图层 + 工程层三层协作模式跑通了,12 小时推完 7 个 task,这个模式后面 30 周都能用

### 5.3 你**不需要**今天就懂的事

- 具体每个文件每行代码做什么(那是工程层的事)
- TenantPolicyRegistry 怎么注入(那是设计模式细节)
- v22 测试套件具体测什么(那是测试工程师的事)

你**作为创始人**今天需要知道的就是**这一份文档**——LIOS 是什么 / 能干什么 / 产品怎么用 / 在龙码体系里占什么位置。

---

## 第六部分:最重要的事

如果今天对话所有信息只能记住一件事,记这件:

> **LIOS v2.2 完工 = 龙码 SaaS 商业模式的工程基础就位。**
>
> **明天起的 30 周,是把这个基础变成赚钱产品的过程。**

---

## 附录:核心文件位置(给未来工程师看)

```
src/policy/TenantPolicy.ts                  - TenantPolicy 接口定义
src/policy/policies/                        - 4 个 tenant policy(electric_commerce / healthcare / tianwen / biaodian)
src/policy/policies/index.ts                - policyById map(注册 policy_id → policy 文件映射)
src/service/LIOSGovernanceService.ts        - LIOS 主服务类
src/service/createGovernanceServiceFromDB.ts - 启动时从 DB 加载 tenant policy
src/access/LIOSAccessControl.ts             - token 验证 + 跨租户校验
src/api/governance.ts                       - HTTP route /lios/runtime/decide
src/db/migrate_v12.ts                       - lios_tenant_policies 表
src/db/migrate_v13.ts                       - tianwen-demo / biaodian-demo 占位 tenant
src/db/migrate_v14.ts                       - lios_access_tokens 表
docs/LIOS_v2.2_白皮书_骨架版_v0.1.md       - 工程白皮书骨架版
docs/LIOS_v2.2_功能与集成说明_v0.1.md      - 本文档
OI_REGISTRY.md                              - OI 待办列表
```

---

**文档结束。**
