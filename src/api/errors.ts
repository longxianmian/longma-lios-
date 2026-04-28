/**
 * LIOS v2.2 Phase β-2 · 错误码与统一错误响应。
 *
 * 按 β-2 决议精简：
 *   - 覆盖 E_REQ_001 / E_KERNEL_001 / E_TIMEOUT_001 / E_INTERNAL
 *   - 不含 E_AUTH_*（γ-5 实施 token 体系时再加）
 *   - 不含 E_AUDITOR_001（BoundsAuditor retry 在 service 内自洽，不泄露给 API 层）
 *
 * 统一响应形态：{ error: ErrorCode, message: string, trace_id: string }
 */

export const ErrorCodes = {
  INVALID_REQUEST: 'E_REQ_001',
  KERNEL_ERROR:    'E_KERNEL_001',
  TIMEOUT:         'E_TIMEOUT_001',
  INTERNAL:        'E_INTERNAL',
} as const;

export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes];

export interface APIErrorBody {
  readonly error: ErrorCode;
  readonly message: string;
  readonly trace_id: string;
}

export class APIError extends Error {
  constructor(
    public readonly code: ErrorCode,
    public readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = 'APIError';
  }
}

export function toErrorBody(
  err: unknown,
  traceId: string,
): { status: number; body: APIErrorBody } {
  if (err instanceof APIError) {
    return {
      status: err.httpStatus,
      body: { error: err.code, message: err.message, trace_id: traceId },
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    status: 500,
    body: { error: ErrorCodes.KERNEL_ERROR, message, trace_id: traceId },
  };
}
