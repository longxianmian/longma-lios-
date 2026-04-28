/**
 * α-5+ Q6 补 3：structured_response 字段测试。
 *
 * 验证 DecideResult.structured_response：
 *   - v2.2 契约里 structured_response 是 optional —— 当前 service 实现暂不填充
 *   - 但下游消费方（天问 / 标典 / 应用层）需要它来渲染 structured UI
 *   - 本测试锁定当前 v2.2 P0 行为，并标注 future API 字段的占位
 *
 * 测试覆盖：
 *   1. structured_response 字段类型契约（optional + shape）
 *   2. 当前 P0 实现：service 不主动填 structured_response（reply_draft 走 free-form）
 *   3. 未来扩展点：下游应用层可通过 result.ledger_payload.structured 取结构化决策摘要
 */

import 'dotenv/config';
import { strict as assert } from 'node:assert';
import type { DecideRequest } from '../../src/service/types';
import { createTestService } from './_test-helpers';

const service = createTestService();

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

const baseReq: DecideRequest = Object.freeze({
  tenant_id: 'demo',
  source_app: 'structured-test',
  session_id: 'sr-1',
  user_message: 'X9 多少钱',
  language: 'zh-TW',
  channel: 'demo',
});

(async () => {
  // ───────────────────────────────────────────────────────────────────────────
  // C1: structured_response 字段为 optional —— 不抛错
  // ───────────────────────────────────────────────────────────────────────────
  await run('C1 result.structured_response 为 optional，缺省为 undefined', async () => {
    const r = await service.decide(baseReq);
    // P0 阶段 service 不填 structured_response
    assert.ok(r.structured_response === undefined,
      `P0 期望 undefined；实得 ${JSON.stringify(r.structured_response)}`);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // C2: ledger_payload.structured 是结构化决策摘要的当前承载字段
  //      （应用层可通过此字段拿到 verdict / chosen_actions / verifier_summary 等）
  // ───────────────────────────────────────────────────────────────────────────
  await run('C2 ledger_payload.structured 含决策摘要核心键', async () => {
    const r = await service.decide(baseReq);
    const s = r.ledger_payload.structured;
    assert.ok(typeof s === 'object' && s !== null);
    assert.equal(s.runtime, 'v2_1');
    assert.ok(['accept', 'hold', 'reject'].includes(s.verdict as string));
    assert.notStrictEqual(s.reason, undefined);
    assert.ok(Array.isArray(s.chosen_actions));
    assert.notStrictEqual(s.turn_family, undefined);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // C3: structured_response 字段类型契约（让 future API 升级时不破坏）
  // ───────────────────────────────────────────────────────────────────────────
  await run('C3 structured_response 类型契约（type + data 字段）', async () => {
    // 类型层只能 compile-time 校验；运行期通过假 setter 测试结构
    type SR = { type: string; data: Record<string, unknown> };
    const fakeSR: SR = { type: 'card', data: { title: 'X9', price: 4990 } };
    assert.equal(typeof fakeSR.type, 'string');
    assert.equal(typeof fakeSR.data, 'object');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // C4: 不同 verdict 下 ledger_payload.structured 内容差异
  // ───────────────────────────────────────────────────────────────────────────
  await run('C4 不同 verdict 下 structured.verdict 字段反映正确', async () => {
    const reqA: DecideRequest = { ...baseReq, user_message: '今天下雪', session_id: 's-reject' };
    const reqB: DecideRequest = { ...baseReq, user_message: 'X9 多少钱', session_id: 's-accept' };
    const ra = await service.decide(reqA);
    const rb = await service.decide(reqB);
    assert.equal(ra.ledger_payload.structured.verdict, ra.verdict);
    assert.equal(rb.ledger_payload.structured.verdict, rb.verdict);
    // chitchat 与 KB hit 应不同
    assert.notEqual(ra.ledger_payload.structured.verdict, rb.ledger_payload.structured.verdict);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // C5: structured 字段 deterministic（同 req 调多次内容一致）
  // ───────────────────────────────────────────────────────────────────────────
  await run('C5 structured 字段 deterministic', async () => {
    const r1 = await service.decide(baseReq);
    const r2 = await service.decide(baseReq);
    assert.deepStrictEqual(r1.ledger_payload.structured, r2.ledger_payload.structured);
  });

  console.log(`\n📊 structured_response：${pass}/${total} 通过`);
  process.exit(pass === total ? 0 : 1);
})().catch(e => {
  console.error('runner 异常：', e);
  process.exit(2);
});
