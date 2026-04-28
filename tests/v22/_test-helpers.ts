/**
 * v22 测试 helper（γ-3 引入）
 *
 * 历史背景：
 *   - γ-1: LIOSGovernanceService.constructor 内部硬编码 register 'demo' 等 3 个 tenant
 *   - γ-3: constructor 改为接受外部 registry（必填），3 行硬编码删除
 *   - 14 处测试 `new LIOSGovernanceService()` 全部需改造
 *
 * 设计：
 *   - createTestRegistry: 默认只 register 'demo' → ElectricCommercePolicy
 *     （γ-3 阶段 v22 测试全部用 'demo' tenant_id；'healthcare' 留 γ-4 引入）
 *   - createTestService: 默认带 mock LLM（matches 13/14 处行为）；
 *     bounds-auditor C2/C3 等需要自己控 extractor/generator/auditor 的测试用
 *     `createTestService({ injectMock: false })` 跳过 mock 注入。
 *
 * 测试改造原则（γ-3 Step 4.1 红线）:
 *   - 只改 setup 部分（`new ... → createTestService()` 这一行）
 *   - 不改业务断言
 *   - 不改测试 case 的输入数据 / 测试名
 */

import { TenantPolicyRegistry } from '../../src/policy/registry/TenantPolicyRegistry';
import { ElectricCommercePolicy } from '../../src/policy/TenantPolicy';
import { LIOSGovernanceService } from '../../src/service/LIOSGovernanceService';
import { injectMockLLM } from './_mock-llm';

export function createTestRegistry(): TenantPolicyRegistry {
  const reg = new TenantPolicyRegistry();
  reg.register('demo', ElectricCommercePolicy);
  return reg;
}

export function createTestService(
  opts: { injectMock?: boolean } = { injectMock: true },
): LIOSGovernanceService {
  const service = new LIOSGovernanceService(createTestRegistry());
  if (opts.injectMock !== false) {
    injectMockLLM(service);
  }
  return service;
}
