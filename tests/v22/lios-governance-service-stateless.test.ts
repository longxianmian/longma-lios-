/**
 * α-4 测试 1：LIOSGovernanceService.decide() 无状态验证。
 *
 * 运行：npx tsx tests/v22/lios-governance-service-stateless.test.ts
 *
 * 验证：
 *   - 同样的 (req) 调用 N 次 → verdict 一致 + ledger_payload.dominant_family 一致
 *   - 用 mock LLM 排除 stochastic 噪音
 *   - service 实例不持有跨调用的状态
 */

import 'dotenv/config';
import { strict as assert } from 'node:assert';
import { LIOSGovernanceService } from '../../src/service/LIOSGovernanceService';
import type { DecideRequest } from '../../src/service/types';
import { injectMockLLM } from './_mock-llm';

const service = new LIOSGovernanceService();
injectMockLLM(service);

const baseReq: DecideRequest = Object.freeze({
  tenant_id: 'demo',
  source_app: 'test',
  session_id: 'stateless-test-1',
  user_message: '我要退貨 100002',
  language: 'zh-TW',
  channel: 'demo',
});

let pass = 0, total = 0;
async function run(name: string, fn: () => Promise<void>) {
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
  // C1: 同 req 调 5 次 → verdict 一致
  // ───────────────────────────────────────────────────────────────────────────
  await run('C1 同 req × 5 次 → verdict 完全一致', async () => {
    const results = [];
    for (let i = 0; i < 5; i++) {
      results.push(await service.decide(baseReq));
    }
    const verdicts = results.map(r => r.verdict);
    const uniq = new Set(verdicts);
    assert.equal(uniq.size, 1, `verdict 不一致：${verdicts.join(',')}`);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // C2: 同 req 调 5 次 → dominant_family 一致
  // ───────────────────────────────────────────────────────────────────────────
  await run('C2 同 req × 5 次 → dominant_family 完全一致', async () => {
    const results = [];
    for (let i = 0; i < 5; i++) {
      results.push(await service.decide(baseReq));
    }
    const families = results.map(r => r.ledger_payload.dominant_family);
    const uniq = new Set(families);
    assert.equal(uniq.size, 1, `dominant_family 不一致：${[...uniq].join(',')}`);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // C3: 同 req 调 5 次 → ledger_payload.pre_kernel_bridge.pre_verdict 一致
  // ───────────────────────────────────────────────────────────────────────────
  await run('C3 pre_kernel_bridge.pre_verdict 完全一致', async () => {
    const results = [];
    for (let i = 0; i < 5; i++) {
      results.push(await service.decide(baseReq));
    }
    const preVerdicts = results.map(r => r.ledger_payload.pre_kernel_bridge.pre_verdict);
    const uniq = new Set(preVerdicts);
    assert.equal(uniq.size, 1, `pre_verdict 不一致：${[...uniq].join(',')}`);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // C4: 不同 req（chitchat vs refund）→ verdict 不同（非平凡 deterministic）
  // ───────────────────────────────────────────────────────────────────────────
  await run('C4 不同 req → verdict 不同（验证 mock 不是常量）', async () => {
    const reqA: DecideRequest = { ...baseReq, user_message: '今天下雪', session_id: 'sa' };
    const reqB: DecideRequest = { ...baseReq, user_message: 'X9 多少钱', session_id: 'sb' };
    const ra = await service.decide(reqA);
    const rb = await service.decide(reqB);
    assert.notEqual(ra.verdict, rb.verdict, `chitchat 与 inquiry 应产生不同 verdict（实得 a=${ra.verdict} b=${rb.verdict}）`);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // C5: service 不持跨调用状态——两次连续调用之间，第二次的输入只与本次 req 有关
  // ───────────────────────────────────────────────────────────────────────────
  await run('C5 不持跨调用状态：第 2 次 verdict 与第 1 次顺序无关', async () => {
    const reqA: DecideRequest = { ...baseReq, user_message: '今天下雪', session_id: 'sc1' };
    const reqB: DecideRequest = { ...baseReq, user_message: '今天下雪', session_id: 'sc2' };
    const r1 = await service.decide(reqA);
    const r2 = await service.decide(reqB);
    assert.equal(r1.verdict, r2.verdict, `两次调用 verdict 应一致；实得 ${r1.verdict} vs ${r2.verdict}`);
  });

  console.log(`\n📊 service stateless：${pass}/${total} 通过`);
  process.exit(pass === total ? 0 : 1);
})().catch(e => {
  console.error('runner 异常：', e);
  process.exit(2);
});
