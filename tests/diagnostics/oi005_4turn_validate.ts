/**
 * OI-005 修复后的 4 轮端到端验证（按 OI-003 工程纪律）。
 *
 * 场景（用户指定）：
 *   T1: 我買的大鵝羽絨服是殘次品
 *   T2: 訂單 9989890
 *   T3: 產品質量有問題
 *   T4: 已拆封
 *
 * 验收：转人工时 handoff_context 至少含 7 个字段（已在的 3 个 + 4 个新增 product_name / product_condition / reason / order_id）。
 */

import 'dotenv/config';
import { conversationRuntime } from '../../src/runtime/ConversationRuntime';
import { query } from '../../src/db/client';

(async () => {
  const sid = `oi005-fix-${Date.now()}`;

  console.log('━'.repeat(72));
  console.log('OI-005 修复验证 · 4 轮真实场景');
  console.log('  session_id =', sid);
  console.log('━'.repeat(72));

  const turns = [
    '我買的大鵝羽絨服是殘次品',
    '訂單 9989890',
    '產品質量有問題',
    '已拆封',
  ];

  for (let i = 0; i < turns.length; i++) {
    const r = await conversationRuntime.handle({
      tenant_id: 'demo', session_id: sid, message: turns[i], lang: 'zh-TW',
    });
    console.log(`\n— T${i + 1} —`);
    console.log(`USER: ${turns[i]}`);
    console.log(`BOT:  ${r.reply}`);
    console.log(`v_legacy=${r.verdict_legacy} v_new=${r.verdict_new} should_escalate=${r.should_escalate}`);
    if (r.handoff_context) {
      console.log(`handoff_context returned at this turn:`);
      console.log(JSON.stringify(r.handoff_context, null, 2));
    }
  }

  // 读入库 handoff_context
  console.log('\n━'.repeat(72));
  console.log('lios_agent_sessions.handoff_context 入库内容：');
  const dbRow = await query<{ handoff_context: unknown }>(
    `SELECT handoff_context FROM lios_agent_sessions WHERE session_id = $1 LIMIT 1`,
    [sid],
  ).catch(() => []);
  const ctx = (dbRow[0]?.handoff_context as Record<string, unknown>) ?? null;
  if (ctx) {
    console.log(JSON.stringify(ctx, null, 2));
  } else {
    console.log('（未入库 / 未触发 escalate）');
  }

  // 7 字段对照
  console.log('\n字段对照表：');
  const expected: Array<[string, string]> = [
    ['user_original_complaint', '用户原始诉求'],
    ['product_name',             '商品名'],
    ['product_condition',        '商品状态'],
    ['order_id',                 '订单号'],
    ['reason',                   '退货/转人工原因'],
    ['verdict_trajectory',       '历轮 verdict'],
    ['collected_verification',   '已核验证据'],
  ];
  let presentCount = 0;
  for (const [f, desc] of expected) {
    const v = ctx?.[f];
    const has = v !== undefined && v !== null && v !== '' &&
                !(Array.isArray(v) && v.length === 0);
    const isMissing = v === 'missing';
    const status = has ? (isMissing ? '🟡 missing 标记' : '✅ 实值') : '❌ 字段缺失';
    if (has) presentCount++;
    console.log(`  ${status.padEnd(18)}  ${f.padEnd(28)} ${desc}`);
    if (has) console.log(`      值：${JSON.stringify(v).slice(0, 120)}`);
  }
  console.log(`\n字段总数：${presentCount}/7  (验收要求 ≥7，含 'missing' 字面值标记也算"含字段")`);

  process.exit(0);
})().catch(e => {
  console.error('验证失败：', e);
  process.exit(1);
});
