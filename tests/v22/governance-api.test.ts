/**
 * β-1 + β-2 + β-3 验收测试：governance HTTP API + 错误码 + trace_link 异步写。
 *
 * 运行：npx tsx tests/v22/governance-api.test.ts
 *
 * 覆盖（按 β-1/β-2/β-3 决议精简：不做 token 验证 / 多租户隔离）：
 *   T1：缺 tenant_id          → 400 + E_REQ_001
 *   T2：valid (price inquiry) → 200 + verdict='accept'
 *   T3：out of scope          → 200 + verdict='reject'
 *   T4：service.decide 抛错   → 500 + E_KERNEL_001
 *   T5：service.decide 超时   → 504 + E_TIMEOUT_001
 *   T6：writeTraceLink 慢     → reply 不阻塞（async fire-and-forget 真异步）
 *   T7：writeTraceLink 抛错   → reply 仍 200，warn 被记录（失败不影响主流程）
 *
 * 用 fastify.inject() 内存调用 + __setWriteTraceLinkForTest 注入 mock；
 * 不需起真服务、不依赖 Redis / WS / workers / lios_trace_links 表。
 */
import 'dotenv/config';
import { strict as assert } from 'node:assert';
import Fastify from 'fastify';
import {
  governanceRoutes,
  setGovernanceService,
  setAccessControl,
  __setWriteTraceLinkForTest,
  __resetWriteTraceLink,
  type TraceLinkPayload,
} from '../../src/api/governance';
import { LIOSAccessControl, InvalidTokenError, type AccessContext } from '../../src/access/LIOSAccessControl';
import { createMultiTenantTestService } from './_test-helpers';

// γ-3：governance.ts 已不再 export `governanceService` const。
// γ-6：升级到 multi-tenant test service (含 demo + tianwen-demo)，让 T_TENANT_ISOLATION 走通。
const governanceService = createMultiTenantTestService();
setGovernanceService(governanceService);

// γ-5/γ-6：stub access control（避免测试依赖真实 lios_access_tokens 表数据）。
// 接受 demo + tianwen 测试 token，其他全部抛 InvalidTokenError。
class StubAccessControl extends LIOSAccessControl {
  override async verify(token: string): Promise<AccessContext> {
    if (token === 'lios_test_token_demo_v22') {
      return Object.freeze({ tenant_id: 'demo', source_app: 'demo' });
    }
    if (token === 'lios_test_token_tianwen_demo_v22') {
      return Object.freeze({ tenant_id: 'tianwen-demo', source_app: 'tianwen' });
    }
    throw new InvalidTokenError();
  }
}
setAccessControl(new StubAccessControl());

const TEST_AUTH = { authorization: 'Bearer lios_test_token_demo_v22' };
const TEST_AUTH_TIANWEN = { authorization: 'Bearer lios_test_token_tianwen_demo_v22' };

// 测试期间默认 writeTraceLink 替换为 noop spy，避免触发真实 DB 写入。
const writeCalls: TraceLinkPayload[] = [];
__setWriteTraceLinkForTest(async (p) => { writeCalls.push(p); });

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
  console.log('β-1 + β-2 + β-3 测试：governance HTTP API + 错误码 + trace_link');
  console.log('━'.repeat(72));

  await run('T1 缺 tenant_id → 400 + E_REQ_001', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/lios/runtime/decide',
      headers: TEST_AUTH,
      payload: { source_app: 'test', session_id: 's1', user_message: 'hi' },
    });
    assert.equal(res.statusCode, 400, `expected 400, got ${res.statusCode}`);
    const body = res.json() as { error: string; trace_id: string };
    assert.equal(body.error, 'E_REQ_001');
    assert.ok(typeof body.trace_id === 'string' && body.trace_id.length > 0);
  });

  await run('T2 valid X9 价格询问 → 200 + verdict=accept', async () => {
    writeCalls.length = 0;
    const res = await app.inject({
      method: 'POST',
      url: '/lios/runtime/decide',
      headers: TEST_AUTH,
      payload: {
        tenant_id: 'demo',
        source_app: 'tianwen',
        app_trace_id: 'app-t2-001',
        session_id: 'beta1-t2',
        user_message: 'X9 多少钱',
      },
    });
    assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);
    const body = res.json() as { verdict: string; trace_id: string };
    assert.equal(body.verdict, 'accept');
    // 等 fire-and-forget 完成
    await new Promise(r => setImmediate(r));
    assert.equal(writeCalls.length, 1, 'writeTraceLink should be called once');
    assert.equal(writeCalls[0].lios_trace_id, body.trace_id);
    assert.equal(writeCalls[0].app_trace_id, 'app-t2-001');
    assert.equal(writeCalls[0].source_app, 'tianwen');
    assert.equal(writeCalls[0].tenant_id, 'demo');
  });

  await run('T3 外部服务请求（订餐） → 200 + verdict=reject', async () => {
    writeCalls.length = 0;
    const res = await app.inject({
      method: 'POST',
      url: '/lios/runtime/decide',
      headers: TEST_AUTH,
      payload: {
        tenant_id: 'demo',
        source_app: 'test',
        session_id: 'beta1-t3',
        user_message: '帮我订餐',
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { verdict: string };
    assert.equal(body.verdict, 'reject');
    await new Promise(r => setImmediate(r));
    assert.equal(writeCalls.length, 1);
    // 没传 app_trace_id → null；没传 source_app（实际有 'test', 这里只验逻辑）
    assert.equal(writeCalls[0].app_trace_id, null);
  });

  await run('T4 service.decide 抛错 → 500 + E_KERNEL_001', async () => {
    (governanceService as unknown as { decide: () => Promise<never> }).decide =
      async () => { throw new Error('synthetic kernel failure'); };
    const res = await app.inject({
      method: 'POST',
      url: '/lios/runtime/decide',
      headers: TEST_AUTH,
      payload: {
        tenant_id: 'demo', source_app: 'test', session_id: 'beta2-t4', user_message: 'X9 多少钱',
      },
    });
    assert.equal(res.statusCode, 500);
    const body = res.json() as { error: string; message: string };
    assert.equal(body.error, 'E_KERNEL_001');
    assert.match(body.message, /synthetic kernel failure/);
  });

  await run('T5 service.decide 超时 → 504 + E_TIMEOUT_001', async () => {
    process.env.LIOS_API_DECIDE_TIMEOUT_MS = '50';
    (governanceService as unknown as { decide: () => Promise<never> }).decide =
      () => new Promise<never>(() => { /* 永不 resolve */ });
    const res = await app.inject({
      method: 'POST',
      url: '/lios/runtime/decide',
      headers: TEST_AUTH,
      payload: {
        tenant_id: 'demo', source_app: 'test', session_id: 'beta2-t5', user_message: 'X9 多少钱',
      },
    });
    assert.equal(res.statusCode, 504);
    const body = res.json() as { error: string };
    assert.equal(body.error, 'E_TIMEOUT_001');
    delete process.env.LIOS_API_DECIDE_TIMEOUT_MS;
  });

  // ── β-3 专项 ───────────────────────────────────────────────────────────────
  // 恢复 service.decide 为真实（带 mock LLM）路径
  (governanceService as unknown as { decide?: unknown }).decide =
    Object.getPrototypeOf(governanceService).decide;

  await run('T6 writeTraceLink 慢（1s） → reply 不阻塞（< 500ms）', async () => {
    let writeFinishedAt = 0;
    __setWriteTraceLinkForTest(async () => {
      await new Promise<void>(r => setTimeout(r, 1000));
      writeFinishedAt = Date.now();
    });
    const t0 = Date.now();
    const res = await app.inject({
      method: 'POST',
      url: '/lios/runtime/decide',
      headers: TEST_AUTH,
      payload: {
        tenant_id: 'demo',
        source_app: 'test',
        session_id: 'beta3-t6',
        user_message: 'X9 多少钱',
      },
    });
    const replyAt = Date.now();
    assert.equal(res.statusCode, 200);
    assert.equal((res.json() as { verdict: string }).verdict, 'accept');
    assert.ok(
      replyAt - t0 < 500,
      `reply should not block on writeTraceLink (took ${replyAt - t0}ms, expected < 500ms)`,
    );
    // 等 trace_link 完成，避免后续测试与 lingering promise 交叉
    while (writeFinishedAt === 0) {
      await new Promise<void>(r => setTimeout(r, 50));
    }
    assert.ok(writeFinishedAt - t0 >= 950, 'writeTraceLink should finish ~1s after request');
  });

  await run('T7 writeTraceLink 抛错 → reply 仍 200，warn 被记录', async () => {
    const warnCalls: Array<{ obj: unknown; msg: unknown }> = [];
    const originalWarn = app.log.warn.bind(app.log);
    (app.log as unknown as { warn: (...a: unknown[]) => void }).warn =
      ((obj: unknown, msg: unknown) => { warnCalls.push({ obj, msg }); }) as never;

    __setWriteTraceLinkForTest(async () => { throw new Error('synthetic db failure'); });

    const res = await app.inject({
      method: 'POST',
      url: '/lios/runtime/decide',
      headers: TEST_AUTH,
      payload: {
        tenant_id: 'demo',
        source_app: 'test',
        session_id: 'beta3-t7',
        user_message: 'X9 多少钱',
      },
    });
    assert.equal(res.statusCode, 200, `reply should still be 200 even when writeTraceLink throws`);
    assert.equal((res.json() as { verdict: string }).verdict, 'accept');

    // .catch 是 microtask，inject 返回时已经 flush；保险等一拍
    await new Promise(r => setImmediate(r));
    const traceLinkWarn = warnCalls.find(
      w => typeof w.msg === 'string' && /trace_link write failed/.test(w.msg as string),
    );
    assert.ok(traceLinkWarn, `expected a 'trace_link write failed' warn, got ${warnCalls.length} unrelated warns`);

    // 还原 logger 与 writeTraceLink
    (app.log as unknown as { warn: typeof originalWarn }).warn = originalWarn;
    __resetWriteTraceLink();
    __setWriteTraceLinkForTest(async () => { /* noop, restore test default */ });
  });

  // ── γ-6：租户隔离测试沉淀 (γ-5 端到端 4 用例 → 永久回归锚点) ───────────────────
  await run('T_AUTH_1 不带 Authorization → 401 + E_AUTH_001', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/lios/runtime/decide',
      payload: { tenant_id: 'demo', source_app: 'test', session_id: 'gamma6-auth1', user_message: 'hi' },
    });
    assert.equal(res.statusCode, 401);
    const body = res.json() as { error: string; message: string };
    assert.equal(body.error, 'E_AUTH_001');
    assert.equal(body.message, 'missing_authorization');
  });

  await run('T_AUTH_2 错 token → 401 + E_AUTH_002', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/lios/runtime/decide',
      headers: { authorization: 'Bearer wrong_token_xyz' },
      payload: { tenant_id: 'demo', source_app: 'test', session_id: 'gamma6-auth2', user_message: 'hi' },
    });
    assert.equal(res.statusCode, 401);
    const body = res.json() as { error: string; message: string };
    assert.equal(body.error, 'E_AUTH_002');
    assert.equal(body.message, 'invalid_token');
  });

  await run('T_AUTH_3 demo token + body=tianwen-demo → 403 + E_AUTH_003 tenant_mismatch', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/lios/runtime/decide',
      headers: TEST_AUTH,
      payload: { tenant_id: 'tianwen-demo', source_app: 'test', session_id: 'gamma6-auth3', user_message: 'hi' },
    });
    assert.equal(res.statusCode, 403);
    const body = res.json() as { error: string; message: string };
    assert.equal(body.error, 'E_AUTH_003');
    assert.match(body.message, /tenant_mismatch/);
    assert.match(body.message, /demo/);
    assert.match(body.message, /tianwen-demo/);
  });

  await run('T_TENANT_ISOLATION tianwen token + body=tianwen-demo → 200 + 不崩溃', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/lios/runtime/decide',
      headers: TEST_AUTH_TIANWEN,
      payload: { tenant_id: 'tianwen-demo', source_app: 'tianwen', session_id: 'gamma6-iso', user_message: 'hi' },
    });
    // 占位骨架走通: 不崩溃即可 (verdict 可能 reject 或 hold, 由 mock LLM 决定)
    assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);
    const body = res.json() as { verdict: string };
    assert.ok(['accept', 'hold', 'reject'].includes(body.verdict),
      `verdict should be one of accept/hold/reject, got ${body.verdict}`);
  });

  console.log('━'.repeat(72));
  console.log(`β-1 + β-2 + β-3 + γ-6 governance API：${pass}/${total} 通过`);
  console.log('━'.repeat(72));

  await app.close();
  process.exit(pass === total ? 0 : 1);
})();
