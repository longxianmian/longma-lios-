/**
 * β-1 + β-2 验收测试：governance HTTP API 路由 + 错误码标准化。
 *
 * 运行：npx tsx tests/v22/governance-api.test.ts
 *
 * 覆盖（按 β-1/β-2 决议精简：不做 token 验证 / 多租户隔离）：
 *   T1：缺 tenant_id          → 400 + E_REQ_001
 *   T2：valid (price inquiry) → 200 + verdict='accept'
 *   T3：out of scope          → 200 + verdict='reject'
 *   T4：service.decide 抛错   → 500 + E_KERNEL_001
 *   T5：service.decide 超时   → 504 + E_TIMEOUT_001
 *
 * 用 fastify.inject() 内存调用，不需起真服务、不依赖 Redis / WS / workers。
 */
import 'dotenv/config';
import { strict as assert } from 'node:assert';
import Fastify from 'fastify';
import { governanceRoutes, governanceService } from '../../src/api/governance';
import { injectMockLLM } from './_mock-llm';

injectMockLLM(governanceService);

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
  const app = Fastify({ logger: false });
  await app.register(governanceRoutes);
  await app.ready();

  console.log('━'.repeat(72));
  console.log('β-1 + β-2 测试：governance HTTP API + 错误码标准化');
  console.log('━'.repeat(72));

  await run('T1 缺 tenant_id → 400 + E_REQ_001', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/lios/runtime/decide',
      payload: { source_app: 'test', session_id: 's1', user_message: 'hi' },
    });
    assert.equal(res.statusCode, 400, `expected 400, got ${res.statusCode}`);
    const body = res.json() as { error: string; trace_id: string };
    assert.equal(body.error, 'E_REQ_001', `expected E_REQ_001, got ${body.error}`);
    assert.ok(typeof body.trace_id === 'string' && body.trace_id.length > 0, 'trace_id missing');
  });

  await run('T2 valid X9 价格询问 → 200 + verdict=accept', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/lios/runtime/decide',
      payload: {
        tenant_id: 'demo',
        source_app: 'test',
        session_id: 'beta1-t2',
        user_message: 'X9 多少钱',
      },
    });
    assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);
    const body = res.json() as { verdict: string; trace_id: string; ledger_payload: unknown };
    assert.equal(body.verdict, 'accept', `expected verdict=accept, got ${body.verdict}`);
    assert.ok(typeof body.trace_id === 'string' && body.trace_id.length > 0, 'trace_id missing');
    assert.ok(body.ledger_payload, 'ledger_payload missing');
  });

  await run('T3 外部服务请求（订餐） → 200 + verdict=reject', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/lios/runtime/decide',
      payload: {
        tenant_id: 'demo',
        source_app: 'test',
        session_id: 'beta1-t3',
        user_message: '帮我订餐',
      },
    });
    assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);
    const body = res.json() as { verdict: string };
    assert.equal(body.verdict, 'reject', `expected verdict=reject, got ${body.verdict}`);
  });

  // T4 / T5 通过 monkey-patch service.decide 触发不同错误路径。
  // 测试在 in-process 单例上 patch；不影响其他测试文件（每个 tsx 进程隔离）。
  await run('T4 service.decide 抛错 → 500 + E_KERNEL_001', async () => {
    (governanceService as unknown as { decide: () => Promise<never> }).decide =
      async () => { throw new Error('synthetic kernel failure'); };
    const res = await app.inject({
      method: 'POST',
      url: '/lios/runtime/decide',
      payload: {
        tenant_id: 'demo', source_app: 'test', session_id: 'beta2-t4', user_message: 'X9 多少钱',
      },
    });
    assert.equal(res.statusCode, 500, `expected 500, got ${res.statusCode}: ${res.body}`);
    const body = res.json() as { error: string; message: string; trace_id: string };
    assert.equal(body.error, 'E_KERNEL_001', `expected E_KERNEL_001, got ${body.error}`);
    assert.match(body.message, /synthetic kernel failure/);
    assert.ok(typeof body.trace_id === 'string' && body.trace_id.length > 0, 'trace_id missing');
  });

  await run('T5 service.decide 超时 → 504 + E_TIMEOUT_001', async () => {
    process.env.LIOS_API_DECIDE_TIMEOUT_MS = '50';
    (governanceService as unknown as { decide: () => Promise<never> }).decide =
      () => new Promise<never>(() => { /* 永不 resolve */ });
    const res = await app.inject({
      method: 'POST',
      url: '/lios/runtime/decide',
      payload: {
        tenant_id: 'demo', source_app: 'test', session_id: 'beta2-t5', user_message: 'X9 多少钱',
      },
    });
    assert.equal(res.statusCode, 504, `expected 504, got ${res.statusCode}: ${res.body}`);
    const body = res.json() as { error: string };
    assert.equal(body.error, 'E_TIMEOUT_001', `expected E_TIMEOUT_001, got ${body.error}`);
    delete process.env.LIOS_API_DECIDE_TIMEOUT_MS;
  });

  console.log('━'.repeat(72));
  console.log(`β-1 + β-2 governance API：${pass}/${total} 通过`);
  console.log('━'.repeat(72));

  await app.close();
  process.exit(pass === total ? 0 : 1);
})();
