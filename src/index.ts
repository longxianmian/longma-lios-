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
import { pool } from './db/client';
import { redis } from './queue/redis';
import { ensureGroups } from './queue/streams';
import { initWebSocketServer } from './ws/server';
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
      'http://localhost:3210',
    ],
  });
  await app.register(sensible);
  await app.register(healthRoutes);
  await app.register(liosRoutes);
  await app.register(pluginRoutes);
  await app.register(assetRoutes);
  await app.register(testRoutes);
  await app.register(tenantRoutes);
  await app.register(decisionRoutes);
  await app.register(chatRoutes);
  await app.register(compareTestRoutes);

  app.addHook('onClose', async () => {
    await pool.end();
    redis.disconnect();
  });

  // ── P1: Redis + WebSocket + Workers ──────────────────────────────────────
  try {
    await redis.connect();
    await ensureGroups();
    app.log.info('[Redis] Connected — async queue ready');

    initWebSocketServer();

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
    app.log.info('LIOS P1 service ready on http://0.0.0.0:3210  WS on :3211');
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
