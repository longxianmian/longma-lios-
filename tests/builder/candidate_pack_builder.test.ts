/**
 * T5 验收测试 —— TenantPolicy + CandidatePackBuilder
 *
 * 运行：  npx tsx tests/builder/candidate_pack_builder.test.ts
 *
 * 验收 case（来自施工方案 T5）：
 *   1. 同 claims，不同 tenant_id 加载到不同 Policy
 *   2. ElectricCommercePolicy 至少配置 5 种业务主张类型
 *
 * 额外保险：
 *   3. KernelInput 含 candidate_actions（按 claim 类型派生）
 *   4. tenant_policy 进入 KernelInput（未泄漏到 Kernel 内核字段）
 *   5. 静态扫描：Policy 内容不在 LIKernel.ts 出现（T6 才会写）；现在仅扫 builder/policy 不导入未来 Kernel
 *   6. order.query 派生 order.lookup action 且 target_object_id = order_id
 *   7. escalation.request 派生 handoff.transfer，scope='conversation'
 */

import { strict as assert } from 'node:assert';
import { CandidatePackBuilder } from '../../src/builder/CandidatePackBuilder';
import { ElectricCommercePolicy, HealthcareConsultPolicy, loadTenantPolicy } from '../../src/policy/TenantPolicy';
import { EvidenceBinder } from '../../src/binder/EvidenceBinder';
import type { Claim } from '../../src/extractor/ClaimExtractor';

const builder = new CandidatePackBuilder();
const binder = new EvidenceBinder();

function claim(t: Claim['type'], content: Record<string, unknown> = {}, target?: string): Claim {
  return Object.freeze({
    type: t,
    content: Object.freeze(content),
    evidence_source: 'user_assertion' as const,
    confidence: 0.85,
    ...(target ? { target } : {}),
  });
}

let pass = 0, total = 0;
function run(name: string, fn: () => void | Promise<void>) {
  total++;
  return Promise.resolve(fn()).then(() => {
    pass++;
    console.log(`✅ ${name}`);
  }).catch(e => {
    console.error(`❌ ${name}\n   ${e instanceof Error ? e.message : String(e)}`);
  });
}

(async () => {
  // ───────────────────────────────────────────────────────────────────────────
  // C1: 同 claims，不同 tenant_id → 不同 Policy
  // ───────────────────────────────────────────────────────────────────────────
  await run('C1 demo vs healthcare-demo 加载不同 Policy', () => {
    const claims = [claim('escalation.request')];
    const ev = binder.bind(claims);

    const k1 = builder.build({
      conversation_id: 'c1', tenant_id: 'demo',
      claims, evidence_pack: ev,
    });
    const k2 = builder.build({
      conversation_id: 'c1', tenant_id: 'healthcare-demo',
      claims, evidence_pack: ev,
    });

    assert.notEqual(k1.tenant_policy.industry, k2.tenant_policy.industry);
    assert.equal(k1.tenant_policy.industry, 'electric_commerce');
    assert.equal(k2.tenant_policy.industry, 'healthcare');
    assert.equal(k1.tenant_policy.escalation_threshold, 3);
    assert.equal(k2.tenant_policy.escalation_threshold, 2);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // C2: ElectricCommercePolicy 至少 5 种业务主张
  // ───────────────────────────────────────────────────────────────────────────
  await run('C2 ElectricCommercePolicy 至少配置 5 种业务主张类型', () => {
    const businessClaims = ElectricCommercePolicy.recognized_claim_types
      .filter(t => !t.startsWith('meta.'));
    assert.ok(businessClaims.length >= 5,
      `期望 ≥5 种业务主张；实得 ${businessClaims.length} 种：${businessClaims.join(',')}`);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // C3: KernelInput 含 candidate_actions
  // ───────────────────────────────────────────────────────────────────────────
  await run('C3 refund.request 派生 candidate_actions 含 refund.initiate', () => {
    const claims = [claim('refund.request', { order_id: '100001', refund_reason: 'defect' })];
    const ev = binder.bind(claims);
    const k = builder.build({
      conversation_id: 'c3', tenant_id: 'demo',
      claims, evidence_pack: ev,
    });
    const refundAction = k.candidate_actions.find(a => a.action_type === 'refund.initiate');
    assert.ok(refundAction, '应派生 refund.initiate 候选动作');
    assert.equal(refundAction.idempotency_scope, 'order_id+refund_reason');
    assert.deepEqual([...refundAction.required_slots].sort(), ['order_id', 'refund_reason']);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // C4: tenant_policy 进入 KernelInput；T6 时 Kernel 不持有它（这里先验证 KernelInput 形态）
  // ───────────────────────────────────────────────────────────────────────────
  await run('C4 KernelInput 形态正确（tenant_policy 是 input 字段）', () => {
    const claims = [claim('chitchat')];
    const ev = binder.bind(claims);
    const k = builder.build({
      conversation_id: 'c4', tenant_id: 'demo',
      claims, evidence_pack: ev,
    });
    assert.ok('tenant_policy' in k);
    assert.ok('candidate_actions' in k);
    assert.ok('claims' in k);
    assert.ok('evidence_pack' in k);
    assert.equal(k.conversation_id, 'c4');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // C5: order.query → order.lookup，target_object_id = order_id
  // ───────────────────────────────────────────────────────────────────────────
  await run('C5 order.query 派生 order.lookup + target_object_id 锚定', () => {
    const claims = [claim('order.query', { order_id: '100001' })];
    const ev = binder.bind(claims);
    const k = builder.build({
      conversation_id: 'c5', tenant_id: 'demo',
      claims, evidence_pack: ev,
    });
    const lookup = k.candidate_actions.find(a => a.action_type === 'order.lookup');
    assert.ok(lookup, '应派生 order.lookup');
    assert.equal(lookup.target_object_id, '100001');
    assert.equal(lookup.idempotency_scope, 'order_id+channel');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // C6: escalation.request → handoff.transfer，scope='conversation'
  // ───────────────────────────────────────────────────────────────────────────
  await run('C6 escalation.request 派生 handoff.transfer + scope=conversation', () => {
    const claims = [claim('escalation.request')];
    const ev = binder.bind(claims);
    const k = builder.build({
      conversation_id: 'c6', tenant_id: 'demo',
      claims, evidence_pack: ev,
    });
    const handoff = k.candidate_actions.find(a => a.action_type === 'handoff.transfer');
    assert.ok(handoff, '应派生 handoff.transfer');
    assert.equal(handoff.idempotency_scope, 'conversation');
    assert.equal(handoff.required_slots.length, 0);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // C7: loadTenantPolicy 兜底到 default（未注册 tenant 不抛错）
  // ───────────────────────────────────────────────────────────────────────────
  await run('C7 loadTenantPolicy 未注册 tenant → 兜底 default', () => {
    const p = loadTenantPolicy('non_existent_tenant_xyz');
    assert.equal(p.industry, 'electric_commerce');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // C8: 静态扫描：CandidatePackBuilder.ts 不 import 任何 Kernel 文件
  // ───────────────────────────────────────────────────────────────────────────
  await run('C8 CandidatePackBuilder.ts 不 import LIKernel 类型', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(
      new URL('../../src/builder/CandidatePackBuilder.ts', import.meta.url),
      'utf-8',
    );
    assert.ok(!/from\s+['"][^'"]*kernel\/LIKernel['"]/.test(src),
      'Builder 不应依赖 Kernel 实现');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // C9: HealthcareConsultPolicy 不识别 refund.request（验证可识别集差异）
  // ───────────────────────────────────────────────────────────────────────────
  await run('C9 healthcare-demo 不识别 refund.request（跨行业差异）', () => {
    assert.ok(!HealthcareConsultPolicy.recognized_claim_types.includes('refund.request' as any));
    assert.ok(ElectricCommercePolicy.recognized_claim_types.includes('refund.request'));
  });

  console.log(`\n📊 CandidatePackBuilder T5 单元测试：${pass}/${total} 通过`);
  process.exit(pass === total ? 0 : 1);
})();
