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
