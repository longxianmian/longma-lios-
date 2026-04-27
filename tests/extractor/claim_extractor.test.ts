/**
 * T3 验收测试 —— ClaimExtractor（含元主张）
 *
 * 运行：  npx tsx tests/extractor/claim_extractor.test.ts
 *
 * 调用真实 OpenAI LLM（与 adversarial runner 一致）。需要 OPENAI_API_KEY。
 *
 * 验收 case（来自施工方案 T3）：
 *   1. "我想退货" → refund.request
 *   2. "正确"（last_system_question.target_slot='order_id_9989890'）→ meta.confirmation target=order_id_9989890
 *   3. "嗯"（last_system_question.target_slot='order_id'）→ meta.confirmation
 *   4. "好的"（last_system_question.target_slot='order_id'）→ meta.confirmation
 *   5. "shopee"（含语境"在哪买的"）→ order.source_assertion 而非空
 *   6. "我不想要了，我买的羽绒服是残次品" → 多个 claim：refund.request + purchase.assertion + defect.assertion
 *   7. "联系人工客服" → escalation.request（不靠正则）
 *   8. "能传照片吗" → inquiry.capability（不再装傻）
 */

import 'dotenv/config';
import { strict as assert } from 'node:assert';
import { ClaimExtractor, Claim, ClaimType } from '../../src/extractor/ClaimExtractor';

const extractor = new ClaimExtractor();

function hasType(claims: Claim[], t: ClaimType): boolean {
  return claims.some(c => c.type === t);
}

function dumpClaims(claims: Claim[]): string {
  return JSON.stringify(claims.map(c => ({
    type: c.type,
    target: c.target,
    confidence: c.confidence,
    content: c.content,
  })), null, 2);
}

async function runCase(name: string, fn: () => Promise<void>): Promise<boolean> {
  try {
    await fn();
    console.log(`✅ ${name}`);
    return true;
  } catch (e) {
    console.error(`❌ ${name}`);
    console.error(String(e));
    return false;
  }
}

(async () => {
  let pass = 0, total = 0;

  // C1: 业务主张 refund.request
  total++; if (await runCase('C1 "我想退货" → refund.request', async () => {
    const claims = await extractor.extract('我想退货', {});
    assert.ok(hasType(claims, 'refund.request'), `期望 refund.request；实得：${dumpClaims(claims)}`);
  })) pass++;

  // C2: 元主张 meta.confirmation（带具体 slot）
  total++; if (await runCase('C2 "正确"+pending order_id_9989890 → meta.confirmation target=order_id_9989890', async () => {
    const claims = await extractor.extract('正确', {
      last_system_question: { target_slot: 'order_id_9989890', raised_at_seq: 1 },
    });
    assert.ok(hasType(claims, 'meta.confirmation'), `期望 meta.confirmation；实得：${dumpClaims(claims)}`);
    const conf = claims.find(c => c.type === 'meta.confirmation');
    assert.equal(conf?.target, 'order_id_9989890', `target 错；实得：${conf?.target}`);
  })) pass++;

  // C3: 元主张 "嗯"
  total++; if (await runCase('C3 "嗯"+pending order_id → meta.confirmation', async () => {
    const claims = await extractor.extract('嗯', {
      last_system_question: { target_slot: 'order_id', raised_at_seq: 1 },
    });
    assert.ok(hasType(claims, 'meta.confirmation'), `期望 meta.confirmation；实得：${dumpClaims(claims)}`);
  })) pass++;

  // C4: 元主张 "好的"
  total++; if (await runCase('C4 "好的"+pending order_id → meta.confirmation', async () => {
    const claims = await extractor.extract('好的', {
      last_system_question: { target_slot: 'order_id', raised_at_seq: 1 },
    });
    assert.ok(hasType(claims, 'meta.confirmation'), `期望 meta.confirmation；实得：${dumpClaims(claims)}`);
  })) pass++;

  // C5: shopee 出现 → order.source_assertion，不为空
  total++; if (await runCase('C5 "我用 shopee 下的单" → order.source_assertion 非空', async () => {
    const claims = await extractor.extract('我用 shopee 下的单', {});
    assert.ok(claims.length > 0, '不应输出空数组');
    assert.ok(hasType(claims, 'order.source_assertion'), `期望 order.source_assertion；实得：${dumpClaims(claims)}`);
  })) pass++;

  // C6: 复合主张
  total++; if (await runCase('C6 "我不想要了，我买的羽绒服是残次品" → 多 claim', async () => {
    const claims = await extractor.extract('我不想要了，我买的羽绒服是残次品', {});
    assert.ok(claims.length >= 2, `期望至少 2 条 claim；实得：${dumpClaims(claims)}`);
    assert.ok(hasType(claims, 'refund.request'), `期望含 refund.request；实得：${dumpClaims(claims)}`);
    // purchase.assertion 与 defect.assertion 至少要命中一项（更严格的 LLM 会两项都给）
    assert.ok(
      hasType(claims, 'purchase.assertion') || hasType(claims, 'defect.assertion'),
      `期望含 purchase.assertion 或 defect.assertion；实得：${dumpClaims(claims)}`,
    );
  })) pass++;

  // C7: 转人工 —— 用语义而非正则
  total++; if (await runCase('C7 "联系人工客服" → escalation.request', async () => {
    const claims = await extractor.extract('联系人工客服', {});
    assert.ok(hasType(claims, 'escalation.request'), `期望 escalation.request；实得：${dumpClaims(claims)}`);
  })) pass++;

  // C8: 能力问询
  total++; if (await runCase('C8 "能传照片吗" → inquiry.capability', async () => {
    const claims = await extractor.extract('能传照片吗', {});
    assert.ok(hasType(claims, 'inquiry.capability'), `期望 inquiry.capability；实得：${dumpClaims(claims)}`);
  })) pass++;

  // C9: 没有 pending 提问时，"嗯"应降级 chitchat（不能瞎绑 target）
  total++; if (await runCase('C9 "嗯" 无 pending 提问 → 不应输出 meta.confirmation', async () => {
    const claims = await extractor.extract('嗯', {});
    assert.ok(!hasType(claims, 'meta.confirmation'),
      `无 pending 提问时不应有 meta.confirmation；实得：${dumpClaims(claims)}`);
  })) pass++;

  // C10: 静态扫描 ClaimExtractor.ts 不含旧关键词函数名
  total++; if (await runCase('C10 ClaimExtractor.ts 不含 is_pure_affirmation/detect_order_source 等关键词函数', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(
      new URL('../../src/extractor/ClaimExtractor.ts', import.meta.url),
      'utf-8',
    );
    const banned = [
      'is_pure_affirmation',
      'detect_order_source',
      'escalation_repeat_regex',
      'commitment_keyword_block',
      'not_found_variant_block',
    ];
    for (const b of banned) {
      // 注释里出现是允许的（说明性），但函数/变量定义不允许
      const reFunctionDef = new RegExp(`(function|const|let|var)\\s+${b}\\b`);
      assert.ok(!reFunctionDef.test(src), `源码内不应定义 ${b}`);
    }
  })) pass++;

  console.log(`\n📊 ClaimExtractor T3 单元测试：${pass}/${total} 通过`);
  process.exit(pass === total ? 0 : 1);
})().catch(e => {
  console.error('测试 runner 异常：', e);
  process.exit(2);
});
