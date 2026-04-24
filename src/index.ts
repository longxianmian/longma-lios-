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
import { pool } from './db/client';

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
  await app.register(cors, { origin: ['http://localhost:5173', 'http://localhost:3210'] });
  await app.register(sensible);
  await app.register(healthRoutes);
  await app.register(liosRoutes);
  await app.register(pluginRoutes);
  await app.register(assetRoutes);
  await app.register(testRoutes);
  await app.register(tenantRoutes);
  await app.register(decisionRoutes);

  app.addHook('onClose', async () => {
    await pool.end();
  });

  try {
    await app.listen({ port: 3210, host: '0.0.0.0' });
    app.log.info('LIOS P0 service ready on http://0.0.0.0:3210');
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
