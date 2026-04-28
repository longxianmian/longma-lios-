/**
 * LIOS v2.2 Phase β-1 + β-2 · 治理服务 HTTP API
 *
 * 暴露 LIOSGovernanceService.decide() 为 HTTP 路由。
 *
 * 边界（β-1 决议）：
 *   - 不做 token 验证（v2.1 全路由惯例：body.tenant_id 模式；token 体系留给 γ-5）
 *   - 不做多租户隔离（留给 γ-6）
 *   - body.tenant_id 缺失 → 400；其他验证由 service 内部处理
 *   - trace_id 在路由层生成，传入 service.decide()，再回写到响应
 *
 * 错误处理（β-2 决议）：
 *   - E_REQ_001    body 校验失败（400）
 *   - E_KERNEL_001 service.decide 抛错（500）
 *   - E_TIMEOUT_001 service.decide 超过 LIOS_API_DECIDE_TIMEOUT_MS（默认 30s, 504）
 *   - E_INTERNAL   plugin scope setErrorHandler 兜底任何漏网异常（500）
 */
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { LIOSGovernanceService } from '../service/LIOSGovernanceService';
import type { DecideRequest } from '../service/types';
import { APIError, ErrorCodes, toErrorBody } from './errors';

export const governanceService = new LIOSGovernanceService();

const decideTimeoutMs = (): number =>
  Number(process.env.LIOS_API_DECIDE_TIMEOUT_MS ?? 30_000);

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new APIError(ErrorCodes.TIMEOUT, 504, `decide timed out after ${ms}ms`)),
      ms,
    );
    p.then(
      v => { clearTimeout(t); resolve(v); },
      e => { clearTimeout(t); reject(e); },
    );
  });
}

export async function governanceRoutes(app: FastifyInstance) {
  app.setErrorHandler((error, _request, reply) => {
    const traceId = randomUUID();
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    if (status >= 400 && status < 500) {
      return reply.code(status).send({
        error: ErrorCodes.INVALID_REQUEST,
        message: error.message,
        trace_id: traceId,
      });
    }
    app.log.error({ err: error, trace_id: traceId }, 'governance unhandled error');
    return reply.code(500).send({
      error: ErrorCodes.INTERNAL,
      message: error.message ?? 'internal error',
      trace_id: traceId,
    });
  });

  app.post<{ Body: Partial<DecideRequest> }>('/lios/runtime/decide', async (request, reply) => {
    const traceId = randomUUID();
    const body = request.body ?? {};

    if (typeof body.tenant_id !== 'string' || body.tenant_id.length === 0) {
      return reply.code(400).send({
        error: ErrorCodes.INVALID_REQUEST,
        message: 'Missing tenant_id',
        trace_id: traceId,
      });
    }

    try {
      const result = await withTimeout(
        governanceService.decide({
          ...(body as DecideRequest),
          trace_id: body.trace_id ?? traceId,
        }),
        decideTimeoutMs(),
      );
      return reply.send({ ...result, trace_id: traceId });
    } catch (e) {
      const { status, body: errBody } = toErrorBody(e, traceId);
      app.log.error({ err: e, trace_id: traceId, code: errBody.error }, 'governance.decide failed');
      return reply.code(status).send(errBody);
    }
  });
}
