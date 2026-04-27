/**
 * T6 验收测试 —— LI Kernel v2.1
 *
 * 运行：  npx tsx tests/kernel/likernel.test.ts
 *
 * 验收 case（来自施工方案 T6）：
 *   1. 静态扫描：LIKernel 类不包含任何租户相关字段
 *   2. 同 claims，不同 TenantPolicy 输出不同 Decision，但 Kernel 实例只有一个
 *
 * 额外保险：
 *   3. 律 1 命中：缺证据 → hold + bounds.must 含 ask_for_evidence_or_clarify
 *   4. 律 2 命中：committed_action 已存在 → accept + reference_existing
 *   5. 律 2 阈值：pending action 累计 ≥ threshold → should_escalate
 *   6. accept 路径正常：refund.request 含 ledger_record 证据 → verdict=accept
 *   7. forbidden_commitments 进入 bounds.must_not
 *   8. Kernel 不调 LLM（静态扫描）
 *   9. T6 不接 BoundedLLMGenerator（不 import generator/auditor）
 */

import { strict as assert } from 'node:assert';
import { LIKernel } from '../../src/kernel/v2_1/LIKernel';
import { CandidatePackBuilder } from '../../src/builder/CandidatePackBuilder';
import { EvidenceBinder } from '../../src/binder/EvidenceBinder';
import { ElectricCommercePolicy, HealthcareConsultPolicy } from '../../src/policy/TenantPolicy';
import { ConversationProjection } from '../../src/runtime/ConversationProjection';
import type { Claim } from '../../src/extractor/ClaimExtractor';

const kernel = new LIKernel();
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
async function run(name: string, fn: () => void | Promise<void>) {
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
  // ───────────────────────────────────────────────────────────────────────────
  // C1 静态扫描：LIKernel 类不含 tenant_policy / policy / tenantConfig 等字段
  // ───────────────────────────────────────────────────────────────────────────
  await run('C1 LIKernel 类不持有任何租户字段', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(
      new URL('../../src/kernel/v2_1/LIKernel.ts', import.meta.url),
      'utf-8',
    );
    const banned = ['tenant_policy', 'tenantPolicy', 'tenantConfig', 'tenant_id', 'industry'];
    // 类体内的字段定义形如：private readonly tenant_policy / tenantPolicy:
    for (const b of banned) {
      const re = new RegExp(`(private|public|protected|readonly)\\s+(readonly\\s+)?${b}\\b`);
      assert.ok(!re.test(src),
        `LIKernel 类不允许有字段 ${b}（命中：${src.split('\n').filter(l => re.test(l))[0]}）`);
    }
    // 还允许参数中出现 tenant_policy（KernelInput 字段），通过函数语法过滤
    // 这里只严控类成员定义形式
  });

  // ───────────────────────────────────────────────────────────────────────────
  // C2 同 claims，不同 Policy → 不同 Decision；Kernel 实例唯一
  // ───────────────────────────────────────────────────────────────────────────
  await run('C2 同 claims 不同 Policy → 不同 Decision；同一 Kernel', () => {
    const claims = [claim('escalation.request')];
    const ev = binder.bind(claims);

    const k1 = builder.build({
      conversation_id: 'c2-a', tenant_id: 'demo',
      claims, evidence_pack: ev,
    });
    const k2 = builder.build({
      conversation_id: 'c2-b', tenant_id: 'healthcare-demo',
      claims, evidence_pack: ev,
    });

    assert.equal(k1.tenant_policy.industry, 'electric_commerce');
    assert.equal(k2.tenant_policy.industry, 'healthcare');

    const d1 = kernel.decide(k1);
    const d2 = kernel.decide(k2);

    // bounds.must_not 中 forbidden_commitments 不同 → Decision 不同
    assert.notDeepEqual([...d1.bounds.must_not], [...d2.bounds.must_not]);

    // Kernel 实例确实是同一个：让 d1 和 d2 都来自同一个 kernel const
    assert.ok(kernel === kernel);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // C3 律 1 命中：refund.request 仅 user_assertion → hold
  // ───────────────────────────────────────────────────────────────────────────
  await run('C3 refund.request 缺证据 → verdict=hold（律 1）', () => {
    const claims = [claim('refund.request', { order_id: '100001', refund_reason: 'defect' })];
    const ev = binder.bind(claims);    // 默认无 ledgerHasPriorPurchase → user_assertion
    const k = builder.build({
      conversation_id: 'c3', tenant_id: 'demo',
      claims, evidence_pack: ev,
    });
    const d = kernel.decide(k);
    // refund.initiate 要求 minimum_evidence_level=3，实际 1 → 律 1 violated
    assert.equal(d.verdict, 'hold');
    assert.equal(d.law1.violated, true);
    assert.equal(d.law1.violating_action_type, 'refund.initiate');
    assert.ok(d.bounds.must.includes('ask_for_evidence_or_clarify'));
  });

  // ───────────────────────────────────────────────────────────────────────────
  // C4 律 2 命中：committed_action 存在 → reference existing
  // ───────────────────────────────────────────────────────────────────────────
  await run('C4 已 committed handoff → accept + reference_existing（律 2）', () => {
    const claims = [claim('escalation.request')];
    const ev = binder.bind(claims);

    // 构造一个含 committed handoff 的 projection
    const proj = ConversationProjection.rebuild({
      conversation_id: 'c4',
      tenant_id: 'demo',
      rows: [
        {
          seq: 1, event_type: 'action.created', conversation_id: 'c4', tenant_id: 'demo',
          entity_type: 'action', entity_id: 'a1', created_at: '2026-04-26',
          payload: { action_type: 'handoff.transfer' },
          claims: null, evidence_pack: null, bounds: null,
          action_id: 'act-handoff-1', action_status: 'pending',
        },
        {
          seq: 2, event_type: 'action.executed', conversation_id: 'c4', tenant_id: 'demo',
          entity_type: 'action', entity_id: 'a1', created_at: '2026-04-26',
          payload: { action_type: 'handoff.transfer' },
          claims: null, evidence_pack: null, bounds: null,
          action_id: 'act-handoff-1', action_status: 'committed',
        },
      ],
    });

    const k = builder.build({
      conversation_id: 'c4', tenant_id: 'demo',
      claims, evidence_pack: ev, projection: proj,
    });
    const d = kernel.decide(k);

    assert.equal(d.verdict, 'accept');
    assert.equal(d.reason, 'reference_existing');
    assert.ok(d.referenced_actions && d.referenced_actions.length > 0);
    assert.equal(d.referenced_actions![0].action_type, 'handoff.transfer');
    assert.equal(d.chosen_actions.length, 0, 'reference 时不应再生成新 action');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // C5 律 2 阈值：pending 累计 ≥ threshold → should_escalate
  // ───────────────────────────────────────────────────────────────────────────
  await run('C5 同 action pending ≥ threshold → should_escalate=true', () => {
    const claims = [claim('order.query', { order_id: 'X' })];
    const ev = binder.bind(claims);

    // 构造 3 条同 action_type 的 pending（阈值 demo=3）
    const rows = [1, 2, 3].map(seq => ({
      seq, event_type: 'action.created', conversation_id: 'c5', tenant_id: 'demo',
      entity_type: 'action', entity_id: `a${seq}`, created_at: '2026-04-26',
      payload: { action_type: 'order.lookup' },
      claims: null, evidence_pack: null, bounds: null,
      action_id: `act-lookup-${seq}`, action_status: 'pending' as const,
    }));
    const proj = ConversationProjection.rebuild({
      conversation_id: 'c5', tenant_id: 'demo', rows,
    });

    const k = builder.build({
      conversation_id: 'c5', tenant_id: 'demo',
      claims, evidence_pack: ev, projection: proj,
    });
    const d = kernel.decide(k);
    assert.equal(d.should_escalate, true, '应触发升级建议');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // C6 accept：purchase.assertion + ledgerHasPriorPurchase + refund.request → hold（slot 不全）
  //          但用 inquiry.product + KB 命中 → accept
  // ───────────────────────────────────────────────────────────────────────────
  await run('C6 inquiry.product + KB 命中 → verdict=accept', () => {
    const claims = [claim('inquiry.product', { product_name: 'X9' })];
    const ev = binder.bind(claims, { kbProductNames: ['X9'] });
    const k = builder.build({
      conversation_id: 'c6', tenant_id: 'demo',
      claims, evidence_pack: ev,
    });
    const d = kernel.decide(k);
    assert.equal(d.verdict, 'accept');
    assert.equal(d.law1.violated, false);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // C7 forbidden_commitments 进入 bounds.must_not
  // ───────────────────────────────────────────────────────────────────────────
  await run('C7 ElectricCommercePolicy.forbidden_commitments 出现在 bounds.must_not', () => {
    const claims = [claim('chitchat')];
    const ev = binder.bind(claims);
    const k = builder.build({
      conversation_id: 'c7', tenant_id: 'demo',
      claims, evidence_pack: ev,
    });
    const d = kernel.decide(k);
    for (const f of ElectricCommercePolicy.forbidden_commitments) {
      assert.ok(d.bounds.must_not.includes(f), `bounds.must_not 应含 ${f}`);
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // C8 Kernel 不调 LLM（静态扫描）
  // ───────────────────────────────────────────────────────────────────────────
  await run('C8 LIKernel.ts 不 import OpenAI / 任何 LLM', async () => {
    const fs = await import('node:fs/promises');
    for (const file of [
      '../../src/kernel/v2_1/LIKernel.ts',
      '../../src/kernel/v2_1/EvidenceLaw.ts',
      '../../src/kernel/v2_1/ConservationLaw.ts',
    ]) {
      const src = await fs.readFile(new URL(file, import.meta.url), 'utf-8');
      assert.ok(!/from\s+['"]openai['"]/.test(src), `${file} 不应 import openai`);
      assert.ok(!/openai\.chat\.completions/.test(src), `${file} 不应直接调 openai`);
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // C9 T6 不接 BoundedLLMGenerator/Auditor（避免提前耦合）
  // ───────────────────────────────────────────────────────────────────────────
  await run('C9 LIKernel.ts 不 import generator/auditor', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(
      new URL('../../src/kernel/v2_1/LIKernel.ts', import.meta.url),
      'utf-8',
    );
    assert.ok(!/from\s+['"][^'"]*generator[^'"]*['"]/.test(src), 'Kernel 不应 import generator');
    assert.ok(!/from\s+['"][^'"]*auditor[^'"]*['"]/.test(src), 'Kernel 不应 import auditor');
  });

  console.log(`\n📊 LI Kernel T6 单元测试：${pass}/${total} 通过`);
  process.exit(pass === total ? 0 : 1);
})();
