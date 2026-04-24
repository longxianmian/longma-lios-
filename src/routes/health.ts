import { FastifyInstance } from 'fastify';
import { pool } from '../db/client';

export async function healthRoutes(app: FastifyInstance) {
  app.get('/health', async (_req, reply) => {
    let dbOk = false;
    let dbLatencyMs = 0;

    try {
      const t0 = Date.now();
      await pool.query('SELECT 1');
      dbLatencyMs = Date.now() - t0;
      dbOk = true;
    } catch {
      dbOk = false;
    }

    const status = dbOk ? 'ok' : 'degraded';
    return reply.code(dbOk ? 200 : 503).send({
      status,
      service: 'longma-lios',
      version: '1.0.0',
      protocol: 'LIOS P0',
      db: {
        connected: dbOk,
        latency_ms: dbLatencyMs,
      },
      uptime_s: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  });
}
