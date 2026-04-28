/**
 * LIOS v2.2 Phase β-1 · 治理服务 HTTP API
 *
 * 暴露 LIOSGovernanceService.decide() 为 HTTP 路由。
 *
 * 边界：
 *   - 不做 token 验证（v2.1 全路由惯例：body.tenant_id 模式；token 体系留给 γ-5）
 *   - 不做多租户隔离（留给 γ-6）
 *   - body.tenant_id 缺失 → 400；其他验证由 service 内部处理
 *   - trace_id 在路由层生成，传入 service.decide()，再回写到响应
 */
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { LIOSGovernanceService } from '../service/LIOSGovernanceService';
import type { DecideRequest } from '../service/types';

export const governanceService = new LIOSGovernanceService();

export async function governanceRoutes(app: FastifyInstance) {
  app.post<{ Body: Partial<DecideRequest> }>('/lios/runtime/decide', async (request, reply) => {
    const traceId = randomUUID();
    const body = request.body ?? {};

    if (typeof body.tenant_id !== 'string' || body.tenant_id.length === 0) {
      return reply.code(400).send({
        error: 'E_REQ_001',
        message: 'Missing tenant_id',
        trace_id: traceId,
      });
    }

    try {
      const result = await governanceService.decide({
        ...(body as DecideRequest),
        trace_id: body.trace_id ?? traceId,
      });
      return reply.send({ ...result, trace_id: traceId });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      app.log.error({ err: e, trace_id: traceId }, 'governance.decide failed');
      return reply.code(500).send({
        error: 'E_INTERNAL',
        message,
        trace_id: traceId,
      });
    }
  });
}
