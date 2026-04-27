#!/usr/bin/env node
/**
 * α-5+ Q9 性能基准。
 *
 * 用法：
 *   node scripts/benchmark.cjs [iterations]   # 默认 3 次
 *
 * 跑固定 case 集合 N 次，记录完整响应 latency（含 LLM 调用）。
 * 输出 per-case avg/min/max + 总 avg。
 *
 * 对比方式：
 *   - 切到 α-2 commit (d86c42a) → npm run benchmark > docs/v2.2/benchmark-alpha2.txt
 *   - 切回 α-3 commit (ba887bb 或更新) → npm run benchmark > docs/v2.2/benchmark-alpha3.txt
 *   - diff 两份，退化 ≤10% 通过
 */

const ITER = parseInt(process.argv[2] ?? '3', 10);
const ENDPOINT = 'http://localhost:3210/lios/chat';
const TENANT = 'demo';

// 固定 case 集——覆盖 accept / hold / reject 三档 + verifier 路径
const CASES = [
  { id: 'chitchat',    msg: '今天下雪',                 expect: 'reject' },
  { id: 'kb_x9_price', msg: 'X9 多少钱',                expect: 'accept' },
  { id: 'order_404',   msg: '我的订单 787678 想退货',   expect: 'hold(verifier)' },
  { id: 'compound',    msg: '我之前买的 X9 怎么升级',   expect: 'hold(slot)' },
];

async function timeOne(c) {
  const sid = `bench-${c.id}-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
  const t0 = Date.now();
  try {
    const r = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenant_id: TENANT, session_id: sid, message: c.msg, lang: 'zh-TW',
      }),
    });
    await r.json();
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, err: String(e) };
  }
  return { ok: true, ms: Date.now() - t0 };
}

async function main() {
  console.log(`benchmark · iterations=${ITER}`);
  console.log('━'.repeat(72));

  const results = {};
  for (const c of CASES) {
    results[c.id] = [];
    process.stdout.write(`[${c.id}] `);
    for (let i = 0; i < ITER; i++) {
      const r = await timeOne(c);
      results[c.id].push(r);
      process.stdout.write(`${r.ms}ms `);
    }
    process.stdout.write('\n');
  }

  console.log('━'.repeat(72));
  console.log('avg / min / max (ms):');
  let totalSum = 0;
  let totalCnt = 0;
  for (const c of CASES) {
    const okRuns = results[c.id].filter(r => r.ok);
    if (okRuns.length === 0) {
      console.log(`  ${c.id.padEnd(12)} all-failed`);
      continue;
    }
    const ms = okRuns.map(r => r.ms);
    const avg = ms.reduce((a, b) => a + b, 0) / ms.length;
    const min = Math.min(...ms);
    const max = Math.max(...ms);
    totalSum += avg;
    totalCnt++;
    console.log(`  ${c.id.padEnd(12)} avg=${avg.toFixed(0).padStart(5)}  min=${String(min).padStart(5)}  max=${String(max).padStart(5)}`);
  }
  if (totalCnt > 0) {
    console.log('━'.repeat(72));
    console.log(`overall avg = ${(totalSum / totalCnt).toFixed(0)}ms`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
