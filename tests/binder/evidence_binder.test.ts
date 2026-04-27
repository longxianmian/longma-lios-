/**
 * T4 验收测试 —— EvidenceBinder（律 1）
 *
 * 运行：  npx tsx tests/binder/evidence_binder.test.ts
 *
 * 验收 case（来自施工方案 T4）：
 *   1. 输入 purchase.assertion（仅 user_assertion）→ 标低证据等级 + pending_evidence
 *   2. 输入 inquiry.product 含 X9 + KB 命中 → 携带 kb_lookup 证据
 *   3. 输入 order.query 含订单号 → 不调 verifier，标 pending_verification
 *
 * 额外保险：
 *   4. meta.confirmation → system_observation 等级 2，不 pending
 *   5. defect.assertion → pending_evidence（无图无订单时）
 *   6. inquiry.product KB 未命中 → pending_evidence（律 1：系统未记录时不可凭空补充）
 *   7. purchase.assertion + ledgerHasPriorPurchase → 升级到 ledger_record 等级 3，不 pending
 */

import { strict as assert } from 'node:assert';
import { EvidenceBinder } from '../../src/binder/EvidenceBinder';
import type { Claim } from '../../src/extractor/ClaimExtractor';

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
function run(name: string, fn: () => void) {
  total++;
  try {
    fn();
    pass++;
    console.log(`✅ ${name}`);
  } catch (e) {
    console.error(`❌ ${name}\n   ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// C1: purchase.assertion 仅 user_assertion → pending_evidence + 等级 1
// ─────────────────────────────────────────────────────────────────────────────
run('C1 purchase.assertion 单独 → pending_evidence/等级 1', () => {
  const pack = binder.bind([
    claim('purchase.assertion', { what: '羽绒服' }),
  ]);
  const b = pack.bindings[0];
  assert.equal(b.evidence_source, 'user_assertion');
  assert.equal(b.evidence_level, 1);
  assert.equal(b.pending, true);
  assert.equal(b.pending_reason, 'pending_evidence');
  assert.equal(pack.has_pending, true);
});

// ─────────────────────────────────────────────────────────────────────────────
// C2: inquiry.product + KB 命中 → kb_lookup + 等级 4
// ─────────────────────────────────────────────────────────────────────────────
run('C2 inquiry.product X9 + KB 命中 → kb_lookup/等级 4', () => {
  const pack = binder.bind(
    [claim('inquiry.product', { product_name: 'X9' })],
    { kbProductNames: ['X9', '龍碼Pro智能手環 X9'] },
  );
  const b = pack.bindings[0];
  assert.equal(b.evidence_source, 'kb_lookup');
  assert.equal(b.evidence_level, 4);
  assert.equal(b.pending, false);
  assert.deepEqual(b.details, { kb_hit: 'X9' });
});

// ─────────────────────────────────────────────────────────────────────────────
// C3: order.query → pending_verification（不调 verifier）
// ─────────────────────────────────────────────────────────────────────────────
run('C3 order.query 100001 → pending_verification', () => {
  const pack = binder.bind([
    claim('order.query', { order_id: '100001' }),
  ]);
  const b = pack.bindings[0];
  assert.equal(b.pending, true);
  assert.equal(b.pending_reason, 'pending_verification');
  // 等级 1 —— 还没 verifier 结果
  assert.equal(b.evidence_level, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// C4: meta.confirmation → system_observation 等级 2，不 pending
// ─────────────────────────────────────────────────────────────────────────────
run('C4 meta.confirmation → system_observation/等级 2', () => {
  const pack = binder.bind([
    claim('meta.confirmation', { confirmed: true }, 'order_id'),
  ]);
  const b = pack.bindings[0];
  assert.equal(b.evidence_source, 'system_observation');
  assert.equal(b.evidence_level, 2);
  assert.equal(b.pending, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// C5: defect.assertion → pending_evidence
// ─────────────────────────────────────────────────────────────────────────────
run('C5 defect.assertion → pending_evidence', () => {
  const pack = binder.bind([
    claim('defect.assertion', { detail: '无法开机' }),
  ]);
  const b = pack.bindings[0];
  assert.equal(b.pending, true);
  assert.equal(b.pending_reason, 'pending_evidence');
});

// ─────────────────────────────────────────────────────────────────────────────
// C6: inquiry.product KB 未命中 → pending_evidence
// ─────────────────────────────────────────────────────────────────────────────
run('C6 inquiry.product 未命中 KB → pending_evidence', () => {
  const pack = binder.bind(
    [claim('inquiry.product', { product_name: '龙码Z99' })],
    { kbProductNames: ['X9', 'Pro智能手环'] },
  );
  const b = pack.bindings[0];
  assert.equal(b.evidence_source, 'user_assertion');
  assert.equal(b.pending, true);
  assert.equal(b.pending_reason, 'pending_evidence');
});

// ─────────────────────────────────────────────────────────────────────────────
// C7: purchase.assertion + ledgerHasPriorPurchase → ledger_record 等级 3
// ─────────────────────────────────────────────────────────────────────────────
run('C7 purchase.assertion + 账本有购买记录 → ledger_record/等级 3', () => {
  const pack = binder.bind(
    [claim('purchase.assertion', { what: 'X9' })],
    { ledgerHasPriorPurchase: true },
  );
  const b = pack.bindings[0];
  assert.equal(b.evidence_source, 'ledger_record');
  assert.equal(b.evidence_level, 3);
  assert.equal(b.pending, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// C8: 复合 pack —— has_pending / highest_level 聚合
// ─────────────────────────────────────────────────────────────────────────────
run('C8 复合 pack 聚合：has_pending + highest_level 正确', () => {
  const pack = binder.bind(
    [
      claim('inquiry.product', { product_name: 'X9' }),       // → kb_lookup
      claim('purchase.assertion', { what: 'X9' }),            // → pending_evidence
      claim('refund.request', { reason: 'defect' }),          // → 不 pending
    ],
    { kbProductNames: ['X9'] },
  );
  assert.equal(pack.has_pending, true);
  assert.equal(pack.highest_level, 4);     // kb_lookup
  assert.equal(pack.bindings.length, 3);
});

// ─────────────────────────────────────────────────────────────────────────────
// C9: EvidenceBinder 不调 verifier、不打 DB（静态扫描）
// ─────────────────────────────────────────────────────────────────────────────
run('C9 EvidenceBinder.ts 不导入 verifier/db', async () => {
  const fs = await import('node:fs/promises');
  const src = await fs.readFile(
    new URL('../../src/binder/EvidenceBinder.ts', import.meta.url),
    'utf-8',
  );
  assert.ok(!/from\s+['"][^'"]*verifier[^'"]*['"]/i.test(src), '不应 import verifier');
  assert.ok(!/from\s+['"][^'"]*db\/(client|ledger)['"]/.test(src), '不应 import db/client 或 db/ledger');
});

console.log(`\n📊 EvidenceBinder T4 单元测试：${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);
