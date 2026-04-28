import 'dotenv/config';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import cors from '@fastify/cors';
import { healthRoutes } from './routes/health';
import { liosRoutes } from './routes/lios';
import { pluginRoutes } from './routes/plugins';
import { assetRoutes } from './routes/assets';
import { testRoutes } from './routes/test';
import { tenantRoutes } from './routes/tenants';
import { decisionRoutes } from './routes/decisions';
import { chatRoutes } from './routes/chat';
import { compareTestRoutes } from './routes/compareTest';
import { agentRoutes } from './routes/agent';
import { governanceRoutes, setGovernanceService, setAccessControl } from './api/governance';
import { ConversationRuntime, setConversationRuntime } from './runtime/ConversationRuntime';
import { createGovernanceServiceFromDB } from './service/createGovernanceServiceFromDB';
import { LIOSAccessControl } from './access/LIOSAccessControl';
import { pool } from './db/client';
import { redis, redisPub } from './queue/redis';
import { ensureGroups } from './queue/streams';
import { initWebSocketServer } from './ws/server';
import { initAgentWebSocketServer } from './ws/agent';
import { startIntentWorker } from './queue/workers/intentWorker';
import { startKernelWorker } from './queue/workers/kernelWorker';
import { startReplyWorker } from './queue/workers/replyWorker';
import { startLedgerWorker } from './queue/workers/ledgerWorker';

const app = Fastify({
  logger: {
    level: 'info',
    transport: {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' },
    },
  },
});

async function main() {
  await app.register(cors, {
    origin: [
      'http://localhost:5173',  // admin frontend
      'http://localhost:5174',  // chat frontend
      'http://localhost:5176',  // agent desk frontend
      'http://localhost:3210',
    ],
  });
  await app.register(sensible);

  // γ-3：启动时从 lios_tenant_policies 加载租户 policy，建 service + runtime 单例。
  // 必须在任何 route register 之前完成，否则 route handler 第一次调用 getXxx() 会抛 "not initialized"。
  const service = await createGovernanceServiceFromDB();
  setGovernanceService(service);
  const runtime = new ConversationRuntime(service);
  setConversationRuntime(runtime);
  // γ-5：注入 LIOSAccessControl（API 访问授权层），preHandler 调用其 verify(token)。
  setAccessControl(new LIOSAccessControl());

  await app.register(healthRoutes);
  await app.register(liosRoutes);
  await app.register(pluginRoutes);
  await app.register(assetRoutes);
  await app.register(testRoutes);
  await app.register(tenantRoutes);
  await app.register(decisionRoutes);
  await app.register(chatRoutes);
  await app.register(compareTestRoutes);
  await app.register(agentRoutes);
  await app.register(governanceRoutes);

  app.addHook('onClose', async () => {
    await pool.end();
    redis.disconnect();
    redisPub.disconnect();
  });

  // ── P1: Redis + WebSocket + Workers ──────────────────────────────────────
  try {
    await redis.connect();
    await ensureGroups();
    app.log.info('[Redis] Connected — async queue ready');

    initWebSocketServer();
    initAgentWebSocketServer();

    // Start workers (non-blocking background loops)
    startIntentWorker().catch(e => app.log.error(e, '[Worker:intent] fatal'));
    startKernelWorker().catch(e => app.log.error(e, '[Worker:kernel] fatal'));
    startReplyWorker().catch(e  => app.log.error(e, '[Worker:reply] fatal'));
    startLedgerWorker().catch(e => app.log.error(e, '[Worker:ledger] fatal'));
  } catch (err) {
    app.log.warn('[Redis] Not available — async queue disabled (P0 sync mode still works)');
  }

  try {
    await app.listen({ port: 3210, host: '0.0.0.0' });
    app.log.info('LIOS service ready · API :3210 · chat WS :3211 · agent WS :3212');
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
