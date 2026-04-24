import { FastifyInstance } from 'fastify';
import { readFileSync } from 'fs';
import { join } from 'path';

// Resolve html relative to project root (two levels up from src/routes/)
const HTML = readFileSync(join(__dirname, '..', '..', 'test-ui.html'), 'utf8');

export async function testRoutes(app: FastifyInstance) {
  app.get('/test', async (_req, reply) => {
    return reply.code(200).header('Content-Type', 'text/html; charset=utf-8').send(HTML);
  });
}
