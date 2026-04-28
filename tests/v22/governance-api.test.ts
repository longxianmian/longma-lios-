/**
 * β-1 验收测试：governance HTTP API 路由。
 *
 * 运行：npx tsx tests/v22/governance-api.test.ts
 *
 * 覆盖范围（按 β-1 决议精简：不做 token 验证 / 多租户隔离）：
 *   T1：缺 tenant_id → 400 + E_REQ_001
 *   T2：valid request (price inquiry) → 200 + verdict='accept'
 *   T3：out of scope (external service) → 200 + verdict='reject'
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
  console.log('β-1 测试：governance HTTP API（无 token，body.tenant_id 模式）');
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

  console.log('━'.repeat(72));
  console.log(`β-1 governance API：${pass}/${total} 通过`);
  console.log('━'.repeat(72));

  await app.close();
  process.exit(pass === total ? 0 : 1);
})();
