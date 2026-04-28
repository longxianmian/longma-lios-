/**
 * α-4 测试 2：projection_snapshot 等价性（mock LLM 排除 stochastic）。
 *
 * 运行：npx tsx tests/v22/projection-snapshot-equivalence-with-mock-llm.test.ts
 *
 * 这是 v2.2 退化判断的核心锚点（OI-009 测量方法升级）。
 *
 * 设计：
 *   用 mock LLM 替换 service 内的 ClaimExtractor / BoundedLLMGenerator / BoundsAuditor
 *   → 同输入永远产生同输出
 *
 * 等价性形态：
 *   对一组多 turn 序列，模拟 ConversationRuntime 的"projection 累计 + 调 decide"
 *   循环跑两遍，两遍的 verdict 序列 + ledger_payload.dominant_family 序列必须完全相等。
 *
 *   这等价于"v2.2 service 决策路径在固定 LLM 输出下完全 deterministic"——
 *   是 v2.2 后续 β/γ/δ 的退化判断基准。
 *
 * 任何不一致 → α-3 改造引入了真正的退化 → 必须回滚。
 */

import 'dotenv/config';
import { strict as assert } from 'node:assert';
import type { LIOSGovernanceService } from '../../src/service/LIOSGovernanceService';
import type { DecideRequest, DecideResult, ProjectionSnapshot } from '../../src/service/types';
import { createTestService } from './_test-helpers';
import { ConversationProjection } from '../../src/runtime/ConversationProjection';

// ─────────────────────────────────────────────────────────────────────────────
// 模拟 ConversationRuntime 的 projection 累计逻辑
// ─────────────────────────────────────────────────────────────────────────────

interface TurnRecord {
  user_message: string;
  verdict: string;
  dominant_family: string;
  pre_verdict: number;
}

async function runConversation(
  service: LIOSGovernanceService,
  session_id: string,
  messages: ReadonlyArray<string>,
): Promise<TurnRecord[]> {
  const records: TurnRecord[] = [];
  let projection = ConversationProjection.empty(session_id, 'demo');

  let seq = 0;
  for (const msg of messages) {
    seq++;

    const req: DecideRequest = {
      tenant_id: 'demo',
      source_app: 'equivalence-test',
      session_id,
      user_message: msg,
      language: 'zh-TW',
      channel: 'demo',
      projection_snapshot: projection as unknown as ProjectionSnapshot,
      pre_extracted_claims: undefined, // 让 service 用 mock extractor
    };

    const result: DecideResult = await service.decide(req);
    records.push({
      user_message: msg,
      verdict: result.verdict,
      dominant_family: result.ledger_payload.dominant_family,
      pre_verdict: result.ledger_payload.pre_kernel_bridge.pre_verdict,
    });

    // 模拟 projection.appendEntry：构造一个模拟 ledger 行（含 attempt_key 让律 2 累计）
    const family = result.ledger_payload.dominant_family;
    const attemptKey = family !== 'unknown' ? `family:${family}` : undefined;
    projection = projection.appendEntry({
      seq,
      event_type: 'kernel.scored',
      conversation_id: session_id,
      tenant_id: 'demo',
      entity_type: 'intent',
      entity_id: `e-${seq}`,
      created_at: '2026-04-27T00:00:00Z',
      payload: { attempt_key: attemptKey, verdict: result.verdict },
      claims: null,
      evidence_pack: null,
      bounds: null,
      action_id: null,
      action_status: null,
    });
  }

  return records;
}

// ─────────────────────────────────────────────────────────────────────────────
// 测试 case：多 turn 序列覆盖律 1 / 律 2 / verifier / hold / reject
// ─────────────────────────────────────────────────────────────────────────────

const sequences: ReadonlyArray<{ id: string; turns: string[] }> = [
  // S19 类：转人工三轮升级
  { id: 'seq_escalate', turns: [
    '我之前买的产品坏了，我要找人工',
    '订单 9989890',
    '麻烦尽快帮我处理',
  ]},
  // 复合主张
  { id: 'seq_compound', turns: [
    '我買的大鵝羽絨服是殘次品',
    '訂單 100002',
    '產品質量有問題',
  ]},
  // 单轮 chitchat
  { id: 'seq_chitchat', turns: ['今天下雪'] },
  // 单轮 X9 价格
  { id: 'seq_x9_price', turns: ['X9 多少钱'] },
  // 多轮 X9 价格（重复同意图）
  { id: 'seq_x9_repeat', turns: ['X9 多少钱', '那 X9 现在啥价格', 'X9 售价是多少呀'] },
];

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
  console.log('━'.repeat(72));
  console.log('α-4 测试 2：projection-snapshot 等价性（mock LLM）');
  console.log('━'.repeat(72));

  // ───────────────────────────────────────────────────────────────────────────
  // 每个 sequence 跑 2 遍，对比 verdict + dominant_family + pre_verdict 序列
  // ───────────────────────────────────────────────────────────────────────────
  for (const seq of sequences) {
    await run(`等价性 ${seq.id} (${seq.turns.length} turn)`, async () => {
      const service1 = createTestService();
      const service2 = createTestService();

      const r1 = await runConversation(service1, `${seq.id}-1`, seq.turns);
      const r2 = await runConversation(service2, `${seq.id}-2`, seq.turns);

      const verdicts1 = r1.map(t => t.verdict);
      const verdicts2 = r2.map(t => t.verdict);
      assert.deepStrictEqual(verdicts1, verdicts2,
        `verdict 序列不一致：\n  v1=${JSON.stringify(verdicts1)}\n  v2=${JSON.stringify(verdicts2)}`);

      const families1 = r1.map(t => t.dominant_family);
      const families2 = r2.map(t => t.dominant_family);
      assert.deepStrictEqual(families1, families2,
        `dominant_family 序列不一致：\n  f1=${JSON.stringify(families1)}\n  f2=${JSON.stringify(families2)}`);

      const pre1 = r1.map(t => t.pre_verdict);
      const pre2 = r2.map(t => t.pre_verdict);
      assert.deepStrictEqual(pre1, pre2,
        `pre_verdict 序列不一致：\n  p1=${JSON.stringify(pre1)}\n  p2=${JSON.stringify(pre2)}`);
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 关键不变量：律 2 family-track 累计在 projection_snapshot 入参下成立
  // ───────────────────────────────────────────────────────────────────────────
  await run('律 2 累计：S19 类 escalate 序列 verdict 序列形态正确', async () => {
    const service = createTestService();
    const records = await runConversation(service, 'law2-test', [
      '我之前买的产品坏了，我要找人工',
      '订单 9989890',
      '麻烦尽快帮我处理',
    ]);
    // 三轮中至少有一轮属 dissatisfaction_track
    const hasDissatisfaction = records.some(r => r.dominant_family === 'dissatisfaction_track');
    assert.ok(hasDissatisfaction,
      `期望含 dissatisfaction_track；实得 ${records.map(r => r.dominant_family).join(',')}`);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 关键不变量：service.decide 同步返回相同 ledger_payload 字段
  // ───────────────────────────────────────────────────────────────────────────
  await run('LedgerPayload 字段稳定（两次调用 deep-equal 主要字段）', async () => {
    const service1 = createTestService();
    const service2 = createTestService();

    const baseReq: DecideRequest = {
      tenant_id: 'demo', source_app: 't', session_id: 'lp-test',
      user_message: '我要退貨 100002', language: 'zh-TW', channel: 'demo',
    };
    const r1 = await service1.decide(baseReq);
    const r2 = await service2.decide(baseReq);

    // 比对 ledger_payload 不含 trace_id / 时间戳
    const stripVolatile = (lp: typeof r1.ledger_payload) => ({
      dominant_family: lp.dominant_family,
      turn_family: lp.turn_family,
      audit_layer: lp.audit_layer,
      audit_retried: lp.audit_retried,
      order_verifier_summary: lp.order_verifier_summary,
      order_verifier_classification: lp.order_verifier_classification,
      order_verifier_id: lp.order_verifier_id,
      pre_kernel_bridge: lp.pre_kernel_bridge,
    });
    assert.deepStrictEqual(stripVolatile(r1.ledger_payload), stripVolatile(r2.ledger_payload));
  });

  console.log(`\n📊 mock-LLM 等价性：${pass}/${total} 通过`);
  if (pass !== total) {
    console.error('\n⚠️ α-3 真退化检测到——回滚 commit f07fcfb 后重新设计 α-3。');
  }
  process.exit(pass === total ? 0 : 1);
})().catch(e => {
  console.error('runner 异常：', e);
  process.exit(2);
});
