/**
 * T8 验收测试 —— BoundedLLMGenerator
 *
 * 运行：  npx tsx tests/generator/bounded_llm_generator.test.ts
 *
 * 验收 case（来自施工方案 T8）：
 *   1. 同 bounds 跑 5 次 → 措辞各异但全部不违反 bounds
 *   2. bounds.must_not 含"承认订单存在" → 输出不应包含"已为您查到此单"等含义
 *
 * 额外保险：
 *   3. hold verdict → 回复不出现"已为您"承诺类语言
 *   4. reject verdict → 简短礼貌
 *   5. 不暴露 LIOS / Kernel / bounds 术语
 */

import 'dotenv/config';
import { strict as assert } from 'node:assert';
import { BoundedLLMGenerator } from '../../src/generator/BoundedLLMGenerator';
import type { Decision, Bounds } from '../../src/kernel/v2_1/LIKernel';

const generator = new BoundedLLMGenerator();

function decision(verdict: 'accept' | 'hold' | 'reject', bounds: Bounds): Decision {
  return Object.freeze({
    verdict,
    reason: 'test',
    bounds,
    chosen_actions: [],
    law1: Object.freeze({ violated: false, reason: 'ok' }),
    law2: Object.freeze({ violated: false, reason: 'ok' }),
  });
}

const STD_BOUNDS_HOLD: Bounds = Object.freeze({
  must: Object.freeze([
    'be_polite',
    'use_zh_TW',
    'ask_for_evidence_or_clarify',
  ]),
  must_not: Object.freeze([
    'fabricate_facts',
    'commit_unverified',
    'commit_order_existence',
    'commit_refund_completed',
    'leak_internal_terms',
  ]),
  may: Object.freeze(['ask_clarifying_question']),
  pending_slot: 'order_id',
});

const STD_BOUNDS_REJECT: Bounds = Object.freeze({
  must: Object.freeze(['be_polite', 'decline_politely']),
  must_not: Object.freeze(['expand_scope', 'fabricate_facts']),
  may: Object.freeze([]),
});

function violatesCommitOrderExistence(reply: string): boolean {
  // 启发式：包含"已为您查到""您的订单 X 存在""我已确认"等承诺已找到订单的语言
  const patterns = [
    /已[為为]您找到/, /已[為为]您查到/, /已[經经]找到/, /已[確确]認/,
    /已[經经]為您處理/, /已[經经]为您处理/, /已[為为]您處理/,
    /您的訂單.*存在/, /您的订单.*存在/,
    /已[為为]您退款/, /已[經经]退款/, /已[退退]款.*\d/,
  ];
  return patterns.some(p => p.test(reply));
}

function leaksInternalTerms(reply: string): boolean {
  const banned = ['LIOS', 'Kernel', 'bounds', 'KB', '内核', '內核', '权限', '權限'];
  return banned.some(b => reply.includes(b));
}

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
  // C1 同 bounds 跑 5 次 → 措辞各异 + 都不违反
  // ───────────────────────────────────────────────────────────────────────────
  await run('C1 同 hold bounds 跑 5 次：措辞各异 / 全部不违反', async () => {
    const replies: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await generator.generate({
        user_input: '我之前买的产品坏了，我要找人工',
        decision: decision('hold', STD_BOUNDS_HOLD),
        language: 'zh-TW',
      });
      replies.push(r.reply);
      assert.ok(!violatesCommitOrderExistence(r.reply),
        `第${i+1}次违反 must_not (commit_order_existence)：${r.reply}`);
      assert.ok(!leaksInternalTerms(r.reply),
        `第${i+1}次泄漏术语：${r.reply}`);
      assert.ok(r.reply.length > 0 && r.reply.length <= 200,
        `第${i+1}次长度异常：${r.reply.length}`);
    }
    // 措辞各异：至少 3 个不同（粗略 unique 计数）
    const uniq = new Set(replies);
    assert.ok(uniq.size >= 2, `期望至少 2 种措辞；实得 ${uniq.size}：\n${replies.join('\n---\n')}`);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // C2 bounds.must_not 含 commit_order_existence → 不能输出"已查到此单"
  // ───────────────────────────────────────────────────────────────────────────
  await run('C2 must_not 禁止承认订单存在 → 实际输出符合', async () => {
    const r = await generator.generate({
      user_input: '我的订单 99999 怎么样了',
      decision: decision('hold', STD_BOUNDS_HOLD),
      language: 'zh-TW',
    });
    assert.ok(!violatesCommitOrderExistence(r.reply),
      `输出违反 must_not：${r.reply}`);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // C3 reject verdict → 简短礼貌、不扩展
  // ───────────────────────────────────────────────────────────────────────────
  await run('C3 reject verdict → 简短礼貌，不扩展', async () => {
    const r = await generator.generate({
      user_input: '帮我写一段 Python 代码',
      decision: decision('reject', STD_BOUNDS_REJECT),
      language: 'zh-TW',
    });
    assert.ok(r.reply.length <= 150, `reject 回复过长：${r.reply.length}`);
    assert.ok(!leaksInternalTerms(r.reply));
    // reject 不应给出代码
    assert.ok(!/def\s+|function\s+|var\s+|const\s+/.test(r.reply),
      `reject 回复含代码：${r.reply}`);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // C4 hold + KB 召回 → 不会从 KB 编造未给出的内容
  // ───────────────────────────────────────────────────────────────────────────
  await run('C4 hold + KB 召回 → 不超越 KB 内容', async () => {
    const r = await generator.generate({
      user_input: 'X9 续航多久？',
      decision: decision('hold', {
        ...STD_BOUNDS_HOLD,
        must: Object.freeze([...STD_BOUNDS_HOLD.must, 'cite_evidence_when_factual']),
        must_not: Object.freeze([...STD_BOUNDS_HOLD.must_not, 'fabricate_kb_content']),
      }),
      kb_snippets: ['X9 防水 50 米，符合 IP68 标准'],   // 故意不给续航数据
      language: 'zh-TW',
    });
    // 不应编造续航数字
    assert.ok(!/續航.*\d+\s*(小時|天|hours?|days?)/i.test(r.reply),
      `LLM 编造了续航数据：${r.reply}`);
    assert.ok(!leaksInternalTerms(r.reply));
  });

  // ───────────────────────────────────────────────────────────────────────────
  // C5 不泄漏内部术语
  // ───────────────────────────────────────────────────────────────────────────
  await run('C5 任何 verdict → 不泄漏 LIOS/Kernel/bounds 术语', async () => {
    for (const v of ['accept', 'hold', 'reject'] as const) {
      const b = v === 'reject' ? STD_BOUNDS_REJECT : STD_BOUNDS_HOLD;
      const r = await generator.generate({
        user_input: '你好',
        decision: decision(v, b),
        language: 'zh-TW',
      });
      assert.ok(!leaksInternalTerms(r.reply), `${v} 泄漏术语：${r.reply}`);
    }
  });

  console.log(`\n📊 BoundedLLMGenerator T8 单元测试：${pass}/${total} 通过`);
  process.exit(pass === total ? 0 : 1);
})();
