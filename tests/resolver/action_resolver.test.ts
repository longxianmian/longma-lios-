/**
 * T7 验收测试 —— ActionResolver 含 Action ID 规则
 *
 * 运行：  npx tsx tests/resolver/action_resolver.test.ts
 *
 * 验收 case（来自施工方案 T7）：
 *   1. 同一会话连发 3 次"联系人工客服" → 第 1 次新 action，第 2/3 次 referenceExisting
 *   2. 用户连查 100001 / 100002 → 各自独立 action_id，不互相拦截
 *   3. 用户分两个不同会话各发起退款 → 不互相拦截
 *
 * 额外保险：
 *   4. 同会话同输入两次咨询 → 同一 action_id（user_input_hash+conversation 范围）
 *   5. 同输入跨会话 → 不同 action_id（conversation 维度隔离）
 *   6. 静态扫描：ActionResolver.ts 不写关键词
 *   7. 入库 + 重读：stagePending → fetchExisting 看到 pending；commit 后看到 committed
 */

import 'dotenv/config';
import { strict as assert } from 'node:assert';
import { ActionResolver, generateActionId, hashUserInput } from '../../src/resolver/ActionResolver';
import { CandidatePackBuilder } from '../../src/builder/CandidatePackBuilder';
import { EvidenceBinder } from '../../src/binder/EvidenceBinder';
import { ElectricCommercePolicy } from '../../src/policy/TenantPolicy';
import { TenantPolicyRegistry } from '../../src/policy/registry/TenantPolicyRegistry';
import { query } from '../../src/db/client';
import type { Claim } from '../../src/extractor/ClaimExtractor';

// γ-1: builder 接受 registry 注入
const registry = new TenantPolicyRegistry();
registry.register('demo', ElectricCommercePolicy);
const resolver = new ActionResolver();
const builder  = new CandidatePackBuilder(registry);
const binder   = new EvidenceBinder();

function claim(t: Claim['type'], content: Record<string, unknown> = {}): Claim {
  return Object.freeze({
    type: t,
    content: Object.freeze(content),
    evidence_source: 'user_assertion' as const,
    confidence: 0.85,
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

const SUITE_ID = `t7-${Date.now()}`;

async function cleanup() {
  await query(
    `DELETE FROM lios_ledgers WHERE conversation_id LIKE $1`,
    [`${SUITE_ID}%`],
  ).catch(() => {});
}

(async () => {
  // ───────────────────────────────────────────────────────────────────────────
  // C1 同会话 3 次转人工 → 第 1 新，第 2/3 reference
  // ───────────────────────────────────────────────────────────────────────────
  await run('C1 同会话 3 次 escalation.request → 第 1 新 / 第 2-3 referenceExisting', async () => {
    const conv = `${SUITE_ID}-c1`;
    const claims = [claim('escalation.request')];
    const ev = binder.bind(claims);
    const k = builder.build({
      conversation_id: conv, tenant_id: 'demo',
      claims, evidence_pack: ev,
    });
    const handoffCa = k.candidate_actions.find(a => a.action_type === 'handoff.transfer')!;

    const ctx = { tenant_id: 'demo', conversation_id: conv };

    const r1 = (await resolver.resolve([handoffCa], ctx))[0];
    assert.equal(r1.already_committed, false);
    await resolver.stagePending(r1, ctx);
    await resolver.commit(r1, ctx);

    const r2 = (await resolver.resolve([handoffCa], ctx))[0];
    assert.equal(r2.action_id, r1.action_id, '同 conversation 同 action_type → 同 ID');
    assert.equal(r2.already_committed, true);

    const r3 = (await resolver.resolve([handoffCa], ctx))[0];
    assert.equal(r3.already_committed, true);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // C2 同会话查 100001 与 100002 → 不同 action_id
  // ───────────────────────────────────────────────────────────────────────────
  await run('C2 同会话连查两个不同订单 → 各自独立 action_id', async () => {
    const conv = `${SUITE_ID}-c2`;
    const make = (oid: string) => {
      const claims = [claim('order.query', { order_id: oid })];
      const ev = binder.bind(claims);
      const k = builder.build({
        conversation_id: conv, tenant_id: 'demo',
        claims, evidence_pack: ev,
      });
      return k.candidate_actions.find(a => a.action_type === 'order.lookup')!;
    };
    const ctx = { tenant_id: 'demo', conversation_id: conv, channel: 'web' };

    const r1 = (await resolver.resolve([make('100001')], ctx))[0];
    const r2 = (await resolver.resolve([make('100002')], ctx))[0];

    assert.notEqual(r1.action_id, r2.action_id, '不同 order_id 必须不同 ID');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // C3 不同会话各发起退款 → 不互相拦截（但范围是 order_id+refund_reason，跨会话同 reason 同单会同 ID）
  // ───────────────────────────────────────────────────────────────────────────
  await run('C3 跨会话退款：order_id+refund_reason 范围跨会话稳定（验证 scope 含义）', async () => {
    const make = (conv: string) => {
      const claims = [claim('refund.request', { order_id: '100001', refund_reason: 'defect' })];
      const ev = binder.bind(claims, { ledgerHasPriorPurchase: true });
      const k = builder.build({
        conversation_id: conv, tenant_id: 'demo',
        claims, evidence_pack: ev,
      });
      return k.candidate_actions.find(a => a.action_type === 'refund.initiate')!;
    };

    const r1 = (await resolver.resolve([make(`${SUITE_ID}-c3-A`)], { tenant_id: 'demo', conversation_id: `${SUITE_ID}-c3-A` }))[0];
    const r2 = (await resolver.resolve([make(`${SUITE_ID}-c3-B`)], { tenant_id: 'demo', conversation_id: `${SUITE_ID}-c3-B` }))[0];

    // scope=order_id+refund_reason 不含 conversation → 同 ID（防止用户在两个 tab 重复申请）
    assert.equal(r1.action_id, r2.action_id, '同 order+reason 跨会话 → 同 ID（范围设计）');
    // 因为各自会话独立查 ledger（fetchExisting 用 conversation_id 过滤），所以 already_committed=false（无入库）
    // 这是设计：跨会话拦截需要在更高层（用户级账本）做，T7 范围不展开
    assert.equal(r1.already_committed, false);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // C4 同会话同输入两次咨询答复 → 同 action_id
  // ───────────────────────────────────────────────────────────────────────────
  await run('C4 同会话同输入答复 → user_input_hash+conversation 范围内同 ID', async () => {
    const conv = `${SUITE_ID}-c4`;
    const claims = [claim('inquiry.product', { product_name: 'X9' })];
    const ev = binder.bind(claims, { kbProductNames: ['X9'] });
    const k = builder.build({
      conversation_id: conv, tenant_id: 'demo',
      claims, evidence_pack: ev,
    });
    const ans = k.candidate_actions.find(a => a.action_type === 'inquiry.answer')!;

    const r1 = (await resolver.resolve([ans], { tenant_id: 'demo', conversation_id: conv, user_input: 'X9 多少钱' }))[0];
    const r2 = (await resolver.resolve([ans], { tenant_id: 'demo', conversation_id: conv, user_input: 'X9 多少钱' }))[0];
    assert.equal(r1.action_id, r2.action_id);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // C5 跨会话同输入 → 不同 action_id
  // ───────────────────────────────────────────────────────────────────────────
  await run('C5 跨会话同输入 → 不同 action_id（conversation 维度隔离）', async () => {
    const claims = [claim('inquiry.product', { product_name: 'X9' })];
    const ev = binder.bind(claims, { kbProductNames: ['X9'] });
    const make = (conv: string) => builder.build({
      conversation_id: conv, tenant_id: 'demo', claims, evidence_pack: ev,
    });

    const ans1 = make(`${SUITE_ID}-c5-A`).candidate_actions.find(a => a.action_type === 'inquiry.answer')!;
    const ans2 = make(`${SUITE_ID}-c5-B`).candidate_actions.find(a => a.action_type === 'inquiry.answer')!;

    const r1 = (await resolver.resolve([ans1], { tenant_id: 'demo', conversation_id: `${SUITE_ID}-c5-A`, user_input: 'X9' }))[0];
    const r2 = (await resolver.resolve([ans2], { tenant_id: 'demo', conversation_id: `${SUITE_ID}-c5-B`, user_input: 'X9' }))[0];

    assert.notEqual(r1.action_id, r2.action_id);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // C6 静态扫描：ActionResolver.ts 无关键词列表 / 平台名硬编码
  // ───────────────────────────────────────────────────────────────────────────
  await run('C6 ActionResolver.ts 无业务关键词函数', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(
      new URL('../../src/resolver/ActionResolver.ts', import.meta.url),
      'utf-8',
    );
    const banned = ['is_pure_affirmation', 'detect_order_source', 'escalation_repeat_regex'];
    for (const b of banned) {
      const re = new RegExp(`(function|const|let|var)\\s+${b}\\b`);
      assert.ok(!re.test(src), `不应定义 ${b}`);
    }
    // 平台名常量数组：不应硬编码
    assert.ok(!/\['shopee'\s*,\s*'lazada'/.test(src),
      'ActionResolver 不应硬编码平台名列表');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // C7 stagePending → 再次 resolve 看到 existing_status=pending；commit 后变 committed
  // ───────────────────────────────────────────────────────────────────────────
  await run('C7 ledger 入库流程：stagePending → committed 状态切换', async () => {
    const conv = `${SUITE_ID}-c7`;
    const claims = [claim('escalation.request')];
    const ev = binder.bind(claims);
    const k = builder.build({
      conversation_id: conv, tenant_id: 'demo',
      claims, evidence_pack: ev,
    });
    const handoffCa = k.candidate_actions.find(a => a.action_type === 'handoff.transfer')!;
    const ctx = { tenant_id: 'demo', conversation_id: conv };

    const r1 = (await resolver.resolve([handoffCa], ctx))[0];
    assert.equal(r1.already_committed, false);
    await resolver.stagePending(r1, ctx);

    const r2 = (await resolver.resolve([handoffCa], ctx))[0];
    assert.equal(r2.already_committed, false);
    assert.equal(r2.existing_status, 'pending');

    await resolver.commit(r1, ctx);
    const r3 = (await resolver.resolve([handoffCa], ctx))[0];
    assert.equal(r3.already_committed, true);
    assert.equal(r3.existing_status, 'committed');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // C8 generateActionId 是稳定 hash（同输入产生同输出）
  // ───────────────────────────────────────────────────────────────────────────
  await run('C8 generateActionId 稳定性（相同输入产生相同 hash）', () => {
    const a = generateActionId({
      tenant_id: 'demo', conversation_id: 'X',
      action_type: 'order.lookup',
      idempotency_scope: 'order_id+channel',
      target_object_id: '100001',
      channel: 'web',
      normalized_claims: [{ type: 'order.query', content: { order_id: '100001' } }],
    });
    const b = generateActionId({
      tenant_id: 'demo', conversation_id: 'X',
      action_type: 'order.lookup',
      idempotency_scope: 'order_id+channel',
      target_object_id: '100001',
      channel: 'web',
      normalized_claims: [{ type: 'order.query', content: { order_id: '100001' } }],
    });
    assert.equal(a, b);
    assert.ok(a.startsWith('act-'));
    assert.equal(a.length, 4 + 16);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // C9 hashUserInput 大小写/空格不敏感
  // ───────────────────────────────────────────────────────────────────────────
  await run('C9 hashUserInput 大小写/空格不敏感', () => {
    assert.equal(hashUserInput('X9 价格'), hashUserInput('  x9 价格  '));
  });

  await cleanup();
  console.log(`\n📊 ActionResolver T7 单元测试：${pass}/${total} 通过`);
  process.exit(pass === total ? 0 : 1);
})().catch(async e => {
  await cleanup();
  console.error('测试 runner 异常：', e);
  process.exit(2);
});
