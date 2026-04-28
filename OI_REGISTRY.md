# LIOS v2.2 OI 注册表

工程性 Open Issues — 不阻断当前 phase 但留待 δ/后续处理。

---

## γ 阶段

### OI-γ-001 — `/lios/runtime/decide` tenant_id 未注册时 500 → 400

- 当前: `registry.get()` throw → governance.ts catch → 500 + E_KERNEL_001
- 期望: 400 + 明确错误信息 (HTTP 语义: client 写错 tenant_id 是 client error)
- 实施位置: `governance.ts` route handler 加 `registry.list()` 反查早返回, 或者 setErrorHandler 内识别 `TenantPolicyRegistry: tenant not registered:` 错误转 400
- 优先级: 低 (功能正确, 仅 HTTP 语义优化)
- 处理时机: δ 阶段或之后
- Ref: γ-3 commit `be048e7`

### OI-γ-002 — healthcare-demo 路径在当前数据下不可达

- 当前: `lios_tenant_policies` 不含 healthcare-demo, 且 `lios_access_tokens` 无对应 token
- 影响: registry 层 "missing throw" 测试通路被 γ-5 跨租户校验提前拦住,
  无法直接测 healthcare-demo 走 service.decide 的 registry 查询失败路径
- 期望路径选择 (二选一):
  1. 给 healthcare-demo 注册 lios_tenant_policies + 发 healthcare token,
     测试通路恢复 (但这意味着 healthcare 占位变成"半生产"状态)
  2. 删除 HealthcareConsultPolicy + policyById healthcare entry (彻底退役)
- 实施位置: 决策点
- 优先级: 低 (γ-3 锚点物理保持, registry 内容仍只来自 DB)
- 处理时机: δ 阶段或之后
- Ref: γ-5 commit `677733a` + γ-6 沉淀分析

---

## δ 阶段

### OI-δ-001 — v2.2 白皮书完整版待补

- 当前: `docs/LIOS_v2.2_白皮书_骨架版_v0.1.md` (骨架版)
- 期望: 完整版含详细架构图 / 各 Phase 设计决策完整复盘 / 蓝图错误 20 项分类与教训 /
  性能基准详细数据 / 与 v2.1 对比的完整 diff / 资产化-标典-天问 P0 接入指南
- 优先级: 中 (工程交付层)
- 处理时机: LIOS v2.2 完工后, 信息资产化系统 P0 启动前

### OI-δ-002 — OTS 锚定证据归档（已解决补登记）

- 状态: 🟢 已解决
- 当前: `artifacts/ots/` 含 `v2.2-complete-hash.txt` + `.ots` + `README.md`
- 解决路径: commit `242308f` (δ-补: OTS 锚定证据归档 artifacts/ots/)
- Ref: v2.2-complete tag 锚定 commit `89e3b35`, 4 OTS 服务器 submit 成功

### OI-δ-003 — lios_assets 系统调研 Task (待办)

- 状态: 🔵 待执行
- 起因: "标典先做用 lios_assets 凑合" 战略候选基于浅调研, 不能拍板; 需完整调研
  lios_assets 真实代码 + 耦合 + 性能, 为后续战略决议提供真实情况依据
- 调研 6 项 (含具体问题):

  **1. 代码量盘点**
  - `src/routes/assets.ts` / `src/services/kbCorpus.ts`
  - `src/services/decision-helpers.ts` `retrieveKBSnippets` 实现
  - 配套 worker / cache / cron 代码（如有）
  - embedding 计算相关代码（如有）
  - 输出: 总 LOC + 文件清单

  **2. 耦合点完整 grep**
  - `grep "lios_assets" / "kbCorpus" / "retrieveKBSnippets"` 命中
  - 每个调用点上下文 5 行
  - 间接依赖识别

  **3. 索引机制真实实现**
  - `embedding` 列由谁写入（HTTP `/reindex` / cron / worker?）
  - embedding model 用什么
  - `lios_embedding_cache` cache key 策略
  - `is_indexed` boolean 翻转时机
  - FTS GIN 索引维护策略

  **4. 多租户隔离现状**
  - `tenant_id` 列是否 NOT NULL
  - 当前 4 行 demo 数据全是 'demo' — 设计如此还是没启用?
  - `retrieveKBSnippets` 是否真按 `tenant_id` 过滤（grep SQL 验证）
  - `scope` 列跟 `tenant_id` 是什么关系

  **5. 性能边界估算**
  - 4 行下检索响应（基线）
  - 4000 行预估
  - FTS + 向量索引 PG 实测
  - `retrieveKBSnippets` 在 `decide()` 耗时占比

  **6. 跟"独立资产化系统"对照**
  - 资产登记 / 版本管理 / 流转 / 锚定 / 跨应用共享 各项有无
  - 结论: lios_assets 是 "资产化系统极简前身" 还是 "完全不同方向"?

- 输出: `docs/lios_assets_系统调研_v0.1.md`
- 调研结果情况分类:
  - **情况 A**: 简单 KB（200-400 LOC, 1-2 处耦合）→ lios_assets 可临时承担标典 KB
  - **情况 B**: 复杂系统（1000+ LOC, 多处耦合）→ 标典直接用 lios_assets 风险高
  - **情况 C**: 已接近资产化系统 → 重新审视战略（资产化 P0 = lios_assets 演进?）
- 优先级: 高 (阻塞下一阶段战略决议 OI-δ-004)
- 处理时机: 下次新对话首项

### OI-δ-004 — lios_assets 战略决议 (pending OI-δ-003)

- 状态: 🟡 pending OI-δ-003 调研完成
- 待决议内容:
  - **候选 X**: 按交接书原顺序（资产化系统作为独立基础设施层 P0, 与 lios_assets 完全分离）
  - **候选 Y**: 标典先做用 lios_assets（lios_assets 临时承担标典 KB 角色）
  - **候选 Z**: 并行（lios_assets 演进为资产化系统 + 标典同时用）
  - **其他**: 视调研结果决定
- 前置依赖: OI-δ-003 调研结果决定哪个候选可行
- 处理时机: OI-δ-003 完成后立即决议

---

## 历史 OI (β 阶段及之前)

详见 commit message 内引用 — `OI-001` 至 `OI-010` 在 Phase α/β 处理:
- `OI-001/002`: LLM 边界波动 (v2.1 期间登记)
- `OI-003`: 工程纪律: 端到端集成测试 (v2.2 持续遵守)
- `OI-004`: T11 阶段 3 删除旧链路 (与 v2.2 解耦)
- `OI-005/006`: handoff_context 字段 + Schema 规范化
- `OI-007`: 未占用
- `OI-008`: OTS 升级已完成
- `OI-009`: 测量方法升级到 mock LLM 等价性
- `OI-010`: ActionResolver 边界澄清
