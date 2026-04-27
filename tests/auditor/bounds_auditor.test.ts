/**
 * T9 验收测试 —— BoundsAuditor 三层审核
 *
 * 运行：  npx tsx tests/auditor/bounds_auditor.test.ts
 *
 * 验收 case（来自施工方案 T9）：
 *   1. 注入"我已经为您退款 100 元"（虚构事实）→ 第二层语义审核拦截 → retry → 仍漂移 → 第三层兜底
 *   2. 注入"您的请求我已收到，请稍候" → 三层全过
 *
 * 额外保险：
 *   3. 第一层结构化拦截：明显 commit_refund_completed → 直接 retry / 兜底
 *   4. 第一层结构化通过 + 第二层语义通过 → layer=semantic / passed=true
 *   5. retry 第二次仍漂移 → 兜底模板
 *   6. forbidden_field（API key）→ 结构层拦截
 *   7. 静态扫描：BoundsAuditor 不写"查無此訂單" 等 6 种关键词正则
 */

import 'dotenv/config';
import { strict as assert } from 'node:assert';
import {
  BoundsAuditor,
  structuralAudit,
  fallbackTemplate,
} from '../../src/auditor/BoundsAuditor';
import type { Decision, Bounds } from '../../src/kernel/v2_1/LIKernel';

const auditor = new BoundsAuditor();

function decision(verdict: 'accept' | 'hold' | 'reject', bounds: Bounds, law1Violated = false): Decision {
  return Object.freeze({
    verdict,
    reason: 'test',
    bounds,
    chosen_actions: [],
    law1: Object.freeze({
      violated: law1Violated,
      reason: law1Violated ? 'evidence_below_threshold:refund.initiate' : 'ok',
    }),
    law2: Object.freeze({ violated: false, reason: 'ok' }),
  });
}

const STD_BOUNDS: Bounds = Object.freeze({
  must: Object.freeze(['be_polite', 'use_zh_TW', 'cite_evidence_when_factual']),
  must_not: Object.freeze([
    'fabricate_facts',
    'commit_refund_completed',
    'commit_order_existence',
    'commit_unverified',
    'leak_internal_terms',
  ]),
  may: Object.freeze([]),
});

let pass = 0, total = 0;
async function run(name: string, fn: () => Promise<void> | void) {
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
  // C1 注入"我已经为您退款 100 元" → 结构层直接拦截 → retry → 仍漂移 → 兜底
  // ───────────────────────────────────────────────────────────────────────────
  await run('C1 虚构退款 → 结构层拦截 → retry 仍漂移 → 兜底模板', async () => {
    const fakeReply = '我已经为您退款 100 元，请查收。';
    const d = decision('hold', STD_BOUNDS, true);
    const r = await auditor.audit(
      { reply: fakeReply, decision: d },
      async () => '退款已成功，金額已退至原支付帳戶。',   // 重试仍漂移
    );
    assert.equal(r.passed, true, 'final result.passed=true（用了兜底）');
    assert.equal(r.layer, 'fallback');
    assert.equal(r.final_text, fallbackTemplate(d).final_text);
    assert.equal(r.retried, true);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // C2 "您的请求我已收到，请稍候" → 三层全过
  // ───────────────────────────────────────────────────────────────────────────
  await run('C2 中性回复 → 三层全过', async () => {
    const cleanReply = '您的請求我已收到，請稍候我幫您查詢。';
    const d = decision('hold', STD_BOUNDS);
    const r = await auditor.audit({ reply: cleanReply, decision: d });
    assert.equal(r.passed, true);
    // 'hold' 必含 ask_for_evidence_or_clarify？此处 STD_BOUNDS 没含，省略
    assert.notEqual(r.layer, 'fallback', `应不进兜底；实得 layer=${r.layer}`);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // C3 第一层显式拦截 commit_refund_completed
  // ───────────────────────────────────────────────────────────────────────────
  await run('C3 结构层 commit_refund_completed 直接拦截', () => {
    const r = structuralAudit('已為您退款 200 元，已完成', STD_BOUNDS);
    assert.equal(r.passed, false);
    assert.ok(r.violations?.includes('commit_refund_completed_violated'));
  });

  // ───────────────────────────────────────────────────────────────────────────
  // C4 第一层 + 第二层全过的中性回复 → layer=semantic 或 structural
  // ───────────────────────────────────────────────────────────────────────────
  await run('C4 中性 hold 回复 → layer ∈ {structural, semantic} / passed=true', async () => {
    const r = await auditor.audit({
      reply: '為了確認您的訂單情況，請告訴我訂單編號，謝謝。',
      decision: decision('hold', {
        ...STD_BOUNDS,
        must: Object.freeze([...STD_BOUNDS.must, 'ask_for_evidence_or_clarify']),
      }),
    });
    assert.equal(r.passed, true);
    assert.notEqual(r.layer, 'fallback');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // C5 retry 第二次仍漂移 → 兜底
  // ───────────────────────────────────────────────────────────────────────────
  await run('C5 retry 第二次仍漂移 → 用兜底', async () => {
    const r = await auditor.audit(
      {
        reply: '已為您找到您的訂單 12345，金額 99 元已退回。',
        decision: decision('hold', STD_BOUNDS, true),
      },
      async () => '您的訂單已退款完成，請查看。',
    );
    assert.equal(r.layer, 'fallback');
    assert.equal(r.passed, true);
    assert.ok(r.final_text.length > 0);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // C6 forbidden_field（API key 模式）→ 结构层拦截
  // ───────────────────────────────────────────────────────────────────────────
  await run('C6 forbidden_field 检测', () => {
    const r = structuralAudit(
      '您的 API key 是 sk-RvanIqHQndaAIE0gnd1234567890abcdef',
      STD_BOUNDS,
    );
    assert.equal(r.passed, false);
    assert.ok(r.violations?.some(v => v.startsWith('forbidden_field')));
  });

  // ───────────────────────────────────────────────────────────────────────────
  // C7 静态扫描：BoundsAuditor 不写关键词正则黑名单（"查無此訂單" 6 变体）
  // ───────────────────────────────────────────────────────────────────────────
  await run('C7 BoundsAuditor.ts 不写关键词正则黑名单', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(
      new URL('../../src/auditor/BoundsAuditor.ts', import.meta.url),
      'utf-8',
    );
    // 不应出现 "查無此訂單" 的多变体黑名单常量数组
    assert.ok(!/查[無无].{0,4}訂單.*查[無无].{0,4}訂單.*查[無无].{0,4}訂單/.test(src),
      '不允许多变体黑名单');
    // 不应出现 not_found_variant_block 名称
    assert.ok(!/not_found_variant_block/.test(src));
  });

  // ───────────────────────────────────────────────────────────────────────────
  // C8 leak_internal_terms 拦截
  // ───────────────────────────────────────────────────────────────────────────
  await run('C8 结构层拦截泄漏术语', () => {
    const r = structuralAudit('您的请求已通过 LIOS Kernel 处理。', STD_BOUNDS);
    assert.equal(r.passed, false);
    assert.ok(r.violations?.includes('leak_internal_terms_violated'));
  });

  // ───────────────────────────────────────────────────────────────────────────
  // C9 must 含 ask_for_evidence_or_clarify 但回复无问号 → 结构层失败
  // ───────────────────────────────────────────────────────────────────────────
  await run('C9 must=ask_for_evidence_or_clarify 但回复无追问 → 结构层失败', () => {
    const r = structuralAudit(
      '訂單情況比較複雜，需要時間。',
      {
        must: Object.freeze(['be_polite', 'ask_for_evidence_or_clarify']),
        must_not: Object.freeze([]),
        may: Object.freeze([]),
      },
    );
    assert.equal(r.passed, false);
    assert.ok(r.violations?.includes('must_ask_for_evidence_missing'));
  });

  // ───────────────────────────────────────────────────────────────────────────
  // C10 fallback 模板按 verdict 分流
  // ───────────────────────────────────────────────────────────────────────────
  await run('C10 fallbackTemplate 按 verdict 分流', () => {
    const dh = decision('hold', STD_BOUNDS);
    const dr = decision('reject', STD_BOUNDS);
    const da = decision('accept', STD_BOUNDS);
    const fh = fallbackTemplate(dh).final_text;
    const fr = fallbackTemplate(dr).final_text;
    const fa = fallbackTemplate(da).final_text;
    assert.notEqual(fh, fr);
    assert.notEqual(fh, fa);
    assert.notEqual(fr, fa);
  });

  console.log(`\n📊 BoundsAuditor T9 单元测试：${pass}/${total} 通过`);
  process.exit(pass === total ? 0 : 1);
})();
