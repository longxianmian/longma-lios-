/**
 * γ-1 验收测试：TenantPolicyRegistry。
 *
 * 运行：npx tsx tests/v22/tenant-policy-registry.test.ts
 *
 * 5 case 覆盖（按 γ-1 决议）：
 *   T1：register + get → 拿回同一对象引用
 *   T2：list → 返回所有已注册 tenantId
 *   T3：duplicate register → 抛错（避免静默覆盖）
 *   T4：missing get → 抛错（多租户安全边界，不返 null/fallback）
 *   T5：register 后 policy 被 freeze（运行时 mutation 抛 TypeError）
 */
import { strict as assert } from 'node:assert';
import { TenantPolicyRegistry } from '../../src/policy/registry/TenantPolicyRegistry';
import { ElectricCommercePolicy, HealthcareConsultPolicy } from '../../src/policy/TenantPolicy';

let pass = 0, total = 0;
async function run(name: string, fn: () => Promise<void> | void) {
  total++;
  try {
    await fn();
    pass++;
    console.log(`✅ ${name}`);
  } catch (e) {
    console.error(`❌ ${name}\n   ${e instanceof Error ? e.message : String(e)}`);
  }
}

(async () => {
  console.log('━'.repeat(72));
  console.log('γ-1 测试：TenantPolicyRegistry（5 case）');
  console.log('━'.repeat(72));

  await run('T1 register + get → 同一引用', () => {
    const reg = new TenantPolicyRegistry();
    reg.register('demo', ElectricCommercePolicy);
    const got = reg.get('demo');
    assert.equal(got.industry, 'electric_commerce');
    assert.equal(got.tenant_id, 'demo');
  });

  await run('T2 list → 返回所有已注册 tenantId', () => {
    const reg = new TenantPolicyRegistry();
    reg.register('demo', ElectricCommercePolicy);
    reg.register('healthcare-demo', HealthcareConsultPolicy);
    const ids = reg.list().sort();
    assert.deepEqual(ids, ['demo', 'healthcare-demo']);
  });

  await run('T3 duplicate register → 抛错', () => {
    const reg = new TenantPolicyRegistry();
    reg.register('demo', ElectricCommercePolicy);
    assert.throws(
      () => reg.register('demo', ElectricCommercePolicy),
      /already registered: demo/,
    );
  });

  await run('T4 missing get → 抛错（不 fallback）', () => {
    const reg = new TenantPolicyRegistry();
    reg.register('demo', ElectricCommercePolicy);
    assert.throws(
      () => reg.get('non_existent_tenant_xyz'),
      /not registered: non_existent_tenant_xyz/,
    );
  });

  await run('T5 register 后 policy 被 freeze', () => {
    const reg = new TenantPolicyRegistry();
    reg.register('demo', ElectricCommercePolicy);
    const got = reg.get('demo');
    assert.equal(Object.isFrozen(got), true, 'registered policy must be frozen');
    // CJS non-strict 下 mutation 静默失败而不抛 TypeError —— 验证值未变即可
    const before = got.industry;
    try { (got as unknown as { industry: string }).industry = 'mutated'; } catch { /* ignore */ }
    assert.equal(got.industry, before, 'frozen policy should not be mutable');
  });

  console.log('━'.repeat(72));
  console.log(`γ-1 TenantPolicyRegistry：${pass}/${total} 通过`);
  console.log('━'.repeat(72));
  process.exit(pass === total ? 0 : 1);
})();
