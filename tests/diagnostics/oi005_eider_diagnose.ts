/**
 * OI-005 诊断脚本（不修代码，只打数据）
 *
 * 用例：「我買的大鵝羽絨服是殘次品」
 *
 * 三件事：
 *   1. ClaimExtractor 抽出几条 claim？类型 + content 全打印
 *   2. EvidenceBinder 给 product_name=大鵝羽絨服 标了什么？kb_lookup / pending_evidence / 等级
 *   3. 走完整 Runtime → 看 handoff_context 实际包含什么字段（如有 escalate）
 */

import 'dotenv/config';
import { ClaimExtractor } from '../../src/extractor/ClaimExtractor';
import { EvidenceBinder } from '../../src/binder/EvidenceBinder';
import { CandidatePackBuilder } from '../../src/builder/CandidatePackBuilder';
import { LIKernel } from '../../src/kernel/v2_1/LIKernel';
import { conversationRuntime } from '../../src/runtime/ConversationRuntime';
import { getKBSnapshot } from '../../src/services/kbCorpus';
import { query } from '../../src/db/client';

const USER_INPUT = '我買的大鵝羽絨服是殘次品';

(async () => {
  console.log('━'.repeat(72));
  console.log('OI-005 诊断 ·「我買的大鵝羽絨服是殘次品」');
  console.log('━'.repeat(72));

  // ─── 1) ClaimExtractor ─────────────────────────────────────────────────────
  console.log('\n【1】 ClaimExtractor.extract');
  const extractor = new ClaimExtractor();
  const claims = await extractor.extract(USER_INPUT, { tenant_id: 'demo' });
  console.log(`抽出 ${claims.length} 条 claim：`);
  claims.forEach((c, i) => {
    console.log(`  [${i + 1}] type=${c.type}`);
    console.log(`      content=${JSON.stringify(c.content)}`);
    console.log(`      evidence_source=${c.evidence_source}  confidence=${c.confidence}`);
    if (c.target) console.log(`      target=${c.target}`);
  });

  // 期望对照
  const types = claims.map(c => c.type);
  const expected = ['refund.request', 'purchase.assertion', 'defect.assertion'];
  const hits = expected.filter(t => types.includes(t as never));
  const missing = expected.filter(t => !types.includes(t as never));
  console.log(`\n期望类型 (3 条核心)：${expected.join(' / ')}`);
  console.log(`实抽命中：${hits.length}/3  → ${hits.join(' / ') || '（无）'}`);
  console.log(`缺失：${missing.join(' / ') || '（无）'}`);

  // 关键检查：purchase.assertion 是否含 product_name='大鵝羽絨服'
  const purchaseClaim = claims.find(c => c.type === 'purchase.assertion');
  if (purchaseClaim) {
    const cnt = purchaseClaim.content as Record<string, unknown>;
    const pn = (cnt.product_name ?? cnt.what) as unknown;
    console.log(`purchase.assertion 中 product_name/what：${typeof pn === 'string' ? `"${pn}"` : '（无）'}`);
    console.log(`  → 是否等于 "大鵝羽絨服"：${pn === '大鵝羽絨服' || pn === '大鹅羽绒服'}`);
  }

  // 关键检查：defect.assertion 是否含 condition='殘次品' 或类似字段
  const defectClaim = claims.find(c => c.type === 'defect.assertion');
  if (defectClaim) {
    const cnt = defectClaim.content as Record<string, unknown>;
    console.log(`defect.assertion 全部字段：${JSON.stringify(cnt)}`);
    const possibleCondFields = ['condition', 'detail', 'issue', 'defect', 'description'];
    const found = possibleCondFields.filter(f => cnt[f] !== undefined && cnt[f] !== null && cnt[f] !== '');
    console.log(`  → "殘次品" 落在字段：${found.join(', ') || '（未明确字段）'}`);
  }

  // ─── 2) EvidenceBinder ─────────────────────────────────────────────────────
  console.log('\n【2】 EvidenceBinder.bind  ——  product_name="大鵝羽絨服" 的处理');
  const kbSnap = await getKBSnapshot('demo');
  console.log(`KB 当前 productNames：${JSON.stringify(kbSnap.productNames)}`);
  console.log(`KB 是否含"大鵝羽絨服"：${kbSnap.productNames.some(n => n.includes('大鵝羽絨') || n.includes('大鹅羽绒'))}`);

  const binder = new EvidenceBinder();
  const pack = binder.bind(claims, { kbProductNames: kbSnap.productNames });
  console.log(`绑定 ${pack.bindings.length} 条；has_pending=${pack.has_pending}；highest_level=${pack.highest_level}`);
  pack.bindings.forEach((b, i) => {
    console.log(`  [${i + 1}] claim.type=${b.claim.type}`);
    console.log(`      content.product_name/what=${(b.claim.content as Record<string, unknown>).product_name ?? (b.claim.content as Record<string, unknown>).what ?? '（无）'}`);
    console.log(`      evidence_source=${b.evidence_source}  level=${b.evidence_level}`);
    console.log(`      pending=${b.pending}${b.pending_reason ? `  reason=${b.pending_reason}` : ''}`);
    if (b.details) console.log(`      details=${JSON.stringify(b.details)}`);
  });

  // 期望对照
  const purchaseBinding = pack.bindings.find(b =>
    b.claim.type === 'purchase.assertion' || b.claim.type === 'inquiry.product',
  );
  if (purchaseBinding) {
    console.log(`\n期望：product_name="大鵝羽絨服" → KB miss → pending_evidence`);
    console.log(`实际：pending=${purchaseBinding.pending}  reason=${purchaseBinding.pending_reason ?? '（无）'}  level=${purchaseBinding.evidence_level}`);
  }

  // ─── 3) 走完整 Runtime → 看 handoff_context ───────────────────────────────
  console.log('\n【3】 完整 Runtime → 触发 escalate → 检查 handoff_context');
  const sid = `oi005-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;

  // 三轮：让律 2 family-track 累计触发 escalate
  const t1 = await conversationRuntime.handle({
    tenant_id: 'demo', session_id: sid, message: USER_INPUT, lang: 'zh-TW',
  });
  console.log(`T1 verdict=${t1.verdict_legacy} should_escalate=${t1.should_escalate} reply="${t1.reply.slice(0, 60)}..."`);

  const t2 = await conversationRuntime.handle({
    tenant_id: 'demo', session_id: sid, message: '订单 9989890', lang: 'zh-TW',
  });
  console.log(`T2 verdict=${t2.verdict_legacy} should_escalate=${t2.should_escalate} reply="${t2.reply.slice(0, 60)}..."`);

  const t3 = await conversationRuntime.handle({
    tenant_id: 'demo', session_id: sid, message: '麻烦尽快帮我处理', lang: 'zh-TW',
  });
  console.log(`T3 verdict=${t3.verdict_legacy} should_escalate=${t3.should_escalate} reply="${t3.reply.slice(0, 60)}..."`);
  console.log(`T3 handoff_context (Runtime 返回)：`);
  console.log(JSON.stringify(t3.handoff_context, null, 2));

  // 从 lios_agent_sessions 读出实际入库的 handoff_context
  const dbRow = await query<{ handoff_context: unknown }>(
    `SELECT handoff_context FROM lios_agent_sessions WHERE session_id = $1 LIMIT 1`,
    [sid],
  ).catch(() => []);
  console.log(`\n入库 lios_agent_sessions.handoff_context：`);
  if (dbRow[0]) {
    console.log(JSON.stringify(dbRow[0].handoff_context, null, 2));
  } else {
    console.log('（未入库）');
  }

  // 期望字段对照
  const ctx = (dbRow[0]?.handoff_context as Record<string, unknown>) ?? null;
  console.log('\n期望 handoff_context 字段对照：');
  const expectedFields: Array<[string, string]> = [
    ['user_original_complaint', '用户原始诉求（首轮 user_input）'],
    ['product_name',             '商品名（如"大鵝羽絨服"）'],
    ['product_condition',        '商品状态（如"殘次品"）'],
    ['reason',                   '退货/转人工原因'],
    ['order_id',                 '订单号（"9989890"）'],
    ['verdict_trajectory',       '历轮 verdict 序列'],
    ['collected_verification',   '已核验的证据/动作'],
  ];
  for (const [f, desc] of expectedFields) {
    const v = ctx?.[f];
    const has = v !== undefined && v !== null && v !== '' &&
                !(Array.isArray(v) && v.length === 0);
    console.log(`  ${has ? '✅' : '❌'}  ${f.padEnd(28)} ${desc}`);
    if (has) console.log(`      实值：${JSON.stringify(v).slice(0, 100)}`);
  }

  console.log('\n━'.repeat(72));
  console.log('诊断完成。决策由用户做。');
  process.exit(0);
})().catch(e => {
  console.error('诊断异常：', e);
  process.exit(1);
});
