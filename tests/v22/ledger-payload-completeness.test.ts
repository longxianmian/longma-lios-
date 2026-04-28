/**
 * α-4 测试 3：LedgerPayload 字段完整性。
 *
 * 运行：npx tsx tests/v22/ledger-payload-completeness.test.ts
 *
 * 验证 service.decide() 返回的 ledger_payload 包含 ConversationRuntime 写完整 9 列
 * + 桥接行 + actions stagePending 所需的全部字段——不漏任何下游消费方依赖的信号。
 *
 * 这是 v2.2 拆分边界书 §3.2 / §6 的硬契约。
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

(async () => {
  const baseReq: DecideRequest = Object.freeze({
    tenant_id: 'demo',
    source_app: 'completeness-test',
    session_id: 'lp-001',
    user_message: '我要退貨 100002',
    language: 'zh-TW',
    channel: 'demo',
  });

  // ───────────────────────────────────────────────────────────────────────────
  // C1: 7 个核心字段非 undefined
  // ───────────────────────────────────────────────────────────────────────────
  await run('C1 ledger_payload 7 个核心字段全部存在', async () => {
    const r = await service.decide(baseReq);
    const lp = r.ledger_payload;
    assert.notStrictEqual(lp.dominant_family, undefined, 'dominant_family 缺');
    assert.notStrictEqual(lp.turn_family, undefined, 'turn_family 缺');
    assert.notStrictEqual(lp.audit_layer, undefined, 'audit_layer 缺');
    assert.notStrictEqual(lp.audit_retried, undefined, 'audit_retried 缺');
    assert.notStrictEqual(lp.pre_kernel_bridge, undefined, 'pre_kernel_bridge 缺');
    assert.notStrictEqual(lp.actions_to_stage, undefined, 'actions_to_stage 缺');
    assert.notStrictEqual(lp.structured, undefined, 'structured 缺');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // C2: pre_kernel_bridge 16 字段完整（兼容旧 runner 桥接行）
  // ───────────────────────────────────────────────────────────────────────────
  await run('C2 pre_kernel_bridge 16 字段全部存在', async () => {
    const r = await service.decide(baseReq);
    const b = r.ledger_payload.pre_kernel_bridge;
    const required = [
      'source', 'pre_verdict', 'pre_reason', 'pre_scope', 'pre_instruction',
      'attempts', 'attempt_log', 'user_claims_extracted', 'claims_verification_status',
      'channel', 'extracted_identifiers', 'verifications_performed',
      'second_pass_verdict', 'second_pass_scope', 'extracted_order_source',
      'is_pure_affirmation',
    ];
    for (const f of required) {
      assert.ok(f in b, `pre_kernel_bridge 缺字段 ${f}`);
    }
    assert.equal(b.source, 'unified_llm_v3_pre_kernel');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // C3: actions_to_stage 是数组（即使空也 ok）
  // ───────────────────────────────────────────────────────────────────────────
  await run('C3 actions_to_stage 是数组', async () => {
    const r = await service.decide(baseReq);
    assert.ok(Array.isArray(r.ledger_payload.actions_to_stage));
  });

  // ───────────────────────────────────────────────────────────────────────────
  // C4: order_verifier_* 三字段：无 verifier 时全部 null（不 undefined）
  // ───────────────────────────────────────────────────────────────────────────
  await run('C4 无 verifier 时 order_verifier_* 字段为 null（非 undefined）', async () => {
    const reqNoVerifier: DecideRequest = {
      ...baseReq,
      user_message: 'X9 多少钱',  // 不触发 verifier
      session_id: 'lp-no-verifier',
    };
    const r = await service.decide(reqNoVerifier);
    assert.strictEqual(r.ledger_payload.order_verifier_classification, null);
    assert.strictEqual(r.ledger_payload.order_verifier_id, null);
    assert.strictEqual(r.ledger_payload.order_verifier_summary, null);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // C5: 有 verifier 时 order_verifier_* 字段填充
  // ───────────────────────────────────────────────────────────────────────────
  await run('C5 有 ExternalEvidence verifier 时 order_verifier_* 字段填充', async () => {
    const reqWithVerifier: DecideRequest = {
      ...baseReq,
      session_id: 'lp-with-verifier',
      external_evidence: [{
        source: 'mock_order_verifier',
        type: 'order_verification',
        data: {
          classification: 'exists_belongs_overdue',
          order_id: '100002',
          summary: 'order_lookup: exists_belongs_overdue; 订单100002; 状态=delivered',
        },
        confidence: 1.0,
      }],
    };
    const r = await service.decide(reqWithVerifier);
    assert.equal(r.ledger_payload.order_verifier_classification, 'exists_belongs_overdue');
    assert.equal(r.ledger_payload.order_verifier_id, '100002');
    assert.ok(r.ledger_payload.order_verifier_summary?.includes('exists_belongs_overdue'));
  });

  // ───────────────────────────────────────────────────────────────────────────
  // C6: structured 字段含 v2.1 兼容键（runtime / verdict / reason / chosen_actions / turn_family）
  // ───────────────────────────────────────────────────────────────────────────
  await run('C6 structured 含 v2.1 兼容键', async () => {
    const r = await service.decide(baseReq);
    const s = r.ledger_payload.structured;
    assert.equal(s.runtime, 'v2_1');
    assert.ok(['accept', 'hold', 'reject'].includes(s.verdict as string));
    assert.notStrictEqual(s.reason, undefined);
    assert.ok(Array.isArray(s.chosen_actions));
    assert.notStrictEqual(s.turn_family, undefined);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // C7: trace_id 必填
  // ───────────────────────────────────────────────────────────────────────────
  await run('C7 result.trace_id 非空', async () => {
    const r = await service.decide(baseReq);
    assert.ok(typeof r.trace_id === 'string' && r.trace_id.length > 0);
  });

  console.log(`\n📊 ledger_payload 完整性：${pass}/${total} 通过`);
  process.exit(pass === total ? 0 : 1);
})().catch(e => {
  console.error('runner 异常：', e);
  process.exit(2);
});
