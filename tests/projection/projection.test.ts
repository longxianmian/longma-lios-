/**
 * T2 验收测试 —— ConversationProjection 不可写原则 + 销毁/重建一致性
 *
 * 运行：  npx tsx tests/projection/projection.test.ts
 *
 * 判定：
 *   销毁投影 → 从同样账本重建 → 两次投影完全相等
 *   投影字段 readonly（运行期 frozen，编译期由 TS 保证）
 */

import { strict as assert } from 'node:assert';
import {
  ConversationProjection,
  LedgerRow,
  LedgerSummary,
} from '../../src/runtime/ConversationProjection';

// ─────────────────────────────────────────────────────────────────────────────
// 构造 10 条账本记录
// ─────────────────────────────────────────────────────────────────────────────

const CONV = 'conv-test-001';
const TENANT = 'tenant-test';

function row(seq: number, partial: Partial<LedgerRow>): LedgerRow {
  return {
    seq,
    event_type: partial.event_type ?? 'pack.created',
    conversation_id: CONV,
    tenant_id: TENANT,
    entity_type: partial.entity_type ?? 'pack',
    entity_id: partial.entity_id ?? `e-${seq}`,
    created_at: '2026-04-26T00:00:00Z',
    payload: partial.payload ?? {},
    claims: partial.claims ?? null,
    evidence_pack: partial.evidence_pack ?? null,
    bounds: partial.bounds ?? null,
    action_id: partial.action_id ?? null,
    action_status: partial.action_status ?? null,
  };
}

const rows: LedgerRow[] = [
  // 1. intent.created — 起始
  row(1, { event_type: 'intent.created', entity_type: 'intent', payload: { user_input: '我要退货' } }),

  // 2. pack.created — 携带 slots（pending: order_id）
  row(2, { event_type: 'pack.created',
           payload: { slots: [{ name: 'order_id', status: 'pending' }] } }),

  // 3. evidence.added — 携带 verification 记录
  row(3, { event_type: 'evidence.added',
           payload: { verification: { type: 'kb_lookup', hit: true } } }),

  // 4. decision.made — 携带 bounds（推导 last_system_question）
  row(4, { event_type: 'decision.made',
           bounds: { pending_slot: 'order_id', must: ['ask_order_id'] } }),

  // 5. action.created — pending action
  row(5, { event_type: 'action.created',
           action_id: 'act-refund-001',
           action_status: 'pending',
           payload: { action_type: 'refund.initiate' } }),

  // 6. attempts +1（attempt_key）
  row(6, { event_type: 'kernel.scored',
           payload: { attempt_key: 'order_not_found' } }),

  // 7. attempts +1 同 key（攒到 2）
  row(7, { event_type: 'kernel.scored',
           payload: { attempt_key: 'order_not_found' } }),

  // 8. slot 填上（pending → filled）
  row(8, { event_type: 'pack.created',
           payload: { slots: [{ name: 'order_id', status: 'filled', value: '100001' }] } }),

  // 9. action.executed — committed
  row(9, { event_type: 'action.executed',
           action_id: 'act-refund-001',
           action_status: 'committed',
           payload: { action_type: 'refund.initiate' } }),

  // 10. ledger.closed
  row(10, { event_type: 'ledger.closed', payload: {} }),
];

const summary: LedgerSummary = { conversation_id: CONV, tenant_id: TENANT, rows };

// ─────────────────────────────────────────────────────────────────────────────
// 测试 1：rebuild 后投影状态符合预期
// ─────────────────────────────────────────────────────────────────────────────

const projA = ConversationProjection.rebuild(summary);

assert.equal(projA.conversation_id, CONV);
assert.equal(projA.tenant_id, TENANT);
assert.equal(projA.computed_from_ledger_seq, 10);

// pending 早被 filled 替换
assert.equal(projA.pending_slots.length, 0);
assert.equal(projA.filled_slots.length, 1);
assert.equal(projA.filled_slots[0].name, 'order_id');
assert.equal(projA.filled_slots[0].value, '100001');

// pending action 已 committed
assert.equal(projA.pending_actions.length, 0);
assert.equal(projA.committed_actions.length, 1);
assert.equal(projA.committed_actions[0].action_id, 'act-refund-001');

// attempts: order_not_found 累计 2
assert.equal(projA.attempts['order_not_found']?.count, 2);

// last_system_question: ask order_id（seq=4 时 raised）
assert.equal(projA.last_system_question?.target_slot, 'order_id');
assert.equal(projA.last_system_question?.raised_at_seq, 4);

// verification_history: 1 条
assert.equal(projA.verification_history.length, 1);

// inferred_phase: 已有 committed_action、无 pending → 'post_action'
assert.equal(projA.inferred_phase, 'post_action');

console.log('✅ test 1 passed — rebuild 状态符合预期');

// ─────────────────────────────────────────────────────────────────────────────
// 测试 2：投影字段 readonly（运行期 frozen）
// ─────────────────────────────────────────────────────────────────────────────

assert.ok(Object.isFrozen(projA), 'projection 实例应 frozen');
assert.ok(Object.isFrozen(projA.pending_slots), 'pending_slots 应 frozen');
assert.ok(Object.isFrozen(projA.filled_slots), 'filled_slots 应 frozen');
assert.ok(Object.isFrozen(projA.attempts), 'attempts 应 frozen');
assert.ok(Object.isFrozen(projA.committed_actions), 'committed_actions 应 frozen');

// 真正触发 TS 编译期错误：以下两行不允许通过 tsc strict 检查
// 运行期由 Object.freeze 保护；strict mode 下 frozen 对象写入抛 TypeError
let mutated = false;
try {
  // @ts-expect-error readonly 字段不可赋值（编译期拦截）
  projA.inferred_phase = 'mutated';
  if ((projA as Readonly<{ inferred_phase: string }>).inferred_phase === 'mutated') mutated = true;
} catch {
  /* 期望抛错（frozen） */
}
assert.ok(!mutated, 'projection 字段不应被外部修改');

try {
  // @ts-expect-error ReadonlyArray 没有 push（编译期拦截）
  projA.filled_slots.push({ name: 'fake', status: 'pending' });
  assert.equal(projA.filled_slots.length, 1, 'filled_slots 不应被 push 改变');
} catch {
  /* 期望 */
}

console.log('✅ test 2 passed — 投影字段 readonly');

// ─────────────────────────────────────────────────────────────────────────────
// 测试 3：销毁后从同一份账本重建 → 与原投影完全相等（除 computed_at）
// ─────────────────────────────────────────────────────────────────────────────

// 销毁原引用
let destroyed: ConversationProjection | null = projA;
const snapA = projA.snapshot();
destroyed = null; // 标记销毁
void destroyed;

// 从同一份 LedgerSummary 重建
const projB = ConversationProjection.rebuild(summary);
const snapB = projB.snapshot();

// computed_at 是时间戳，每次不同；其它必须相等
const stripTime = (s: ReturnType<ConversationProjection['snapshot']>) => {
  const { computed_at: _ca, ...rest } = s as any;
  return rest;
};

assert.deepStrictEqual(
  stripTime(snapA),
  stripTime(snapB),
  '销毁后从同一账本重建必须得到完全相等的投影',
);

console.log('✅ test 3 passed — 销毁/重建一致');

// ─────────────────────────────────────────────────────────────────────────────
// 测试 4：appendEntry 是不可变操作（返回新实例 / 原实例不变）
// ─────────────────────────────────────────────────────────────────────────────

const empty = ConversationProjection.empty(CONV, TENANT);
const after = empty.appendEntry(rows[0]);
assert.notStrictEqual(empty, after, 'appendEntry 应返回新实例');
assert.equal(empty.computed_from_ledger_seq, 0, '原投影 seq 不变');
assert.equal(after.computed_from_ledger_seq, 1, '新投影 seq=1');

console.log('✅ test 4 passed — appendEntry 不可变');

// ─────────────────────────────────────────────────────────────────────────────
// 测试 5：幂等回放 —— 重复 append 同一行不改状态
// ─────────────────────────────────────────────────────────────────────────────

const replayed = projA.appendEntry(rows[5]);  // seq=6, 已被消化
assert.strictEqual(replayed, projA, '重复回放低 seq 行应返回同一引用');

console.log('✅ test 5 passed — 幂等回放');

console.log('\n🎉 ALL T2 PROJECTION TESTS PASSED');
