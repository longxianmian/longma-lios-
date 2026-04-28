/**
 * LIOS v2.2 Phase β-1 + β-2 + β-3 · 治理服务 HTTP API
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
 *
 * trace_id 跨系统关联（β-3 决议）：
 *   - reply.send 之后异步写 lios_trace_links（fire-and-forget，失败只 warn）
 *   - 不阻塞主流程；写表失败不影响 decide 响应
 */
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { LIOSGovernanceService } from '../service/LIOSGovernanceService';
import type { DecideRequest } from '../service/types';
import { APIError, ErrorCodes, toErrorBody } from './errors';
import { query } from '../db/client';

export const governanceService = new LIOSGovernanceService();

export interface TraceLinkPayload {
  readonly lios_trace_id: string;
  readonly app_trace_id: string | null;
  readonly source_app: string;
  readonly tenant_id: string;
}

export type WriteTraceLinkFn = (payload: TraceLinkPayload) => Promise<void>;

const defaultWriteTraceLink: WriteTraceLinkFn = async (p) => {
  await query(
    `INSERT INTO lios_trace_links (lios_trace_id, app_trace_id, source_app, tenant_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (lios_trace_id) DO NOTHING`,
    [p.lios_trace_id, p.app_trace_id, p.source_app, p.tenant_id],
  );
};

let writeTraceLinkImpl: WriteTraceLinkFn = defaultWriteTraceLink;

/** 测试用：替换 writeTraceLink 实现（mock / spy）。 */
export function __setWriteTraceLinkForTest(fn: WriteTraceLinkFn): void {
  writeTraceLinkImpl = fn;
}

/** 测试用：恢复默认 DB 实现。 */
export function __resetWriteTraceLink(): void {
  writeTraceLinkImpl = defaultWriteTraceLink;
}

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

      // β-3：fire-and-forget 写 trace_link，失败不影响响应
      void writeTraceLinkImpl({
        lios_trace_id: traceId,
        app_trace_id: typeof body.app_trace_id === 'string' ? body.app_trace_id : null,
        source_app: typeof body.source_app === 'string' && body.source_app.length > 0
          ? body.source_app
          : 'unknown',
        tenant_id: body.tenant_id,
      }).catch(err => {
        app.log.warn({ err, trace_id: traceId }, 'trace_link write failed');
      });

      return reply.send({ ...result, trace_id: traceId });
    } catch (e) {
      const { status, body: errBody } = toErrorBody(e, traceId);
      app.log.error({ err: e, trace_id: traceId, code: errBody.error }, 'governance.decide failed');
      return reply.code(status).send(errBody);
    }
  });
}
