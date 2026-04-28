/**
 * LIOSAccessControl — v2.2 Phase γ-5
 *
 * LIOS API 访问授权层。验证 /lios/runtime/decide 等路由的 Bearer token，
 * 把 token 解析为 (tenant_id, source_app) AccessContext。
 *
 * 边界（与 v2.1 lios_tenants.token 物理隔离）：
 *   - v2.1 lios_tenants.token       — 商户登录令牌（身份认证）
 *   - γ-5 lios_access_tokens.token  — API 访问授权令牌（本类负责）
 *   两套 token 完全独立，不互通。
 *
 * 不缓存（每次调 DB）：γ-5 P0 不做性能优化，需要时未来引入 LRU。
 */

import { queryOne } from '../db/client';

export interface AccessContext {
  readonly tenant_id: string;
  readonly source_app: string;
}

export class InvalidTokenError extends Error {
  constructor(message = 'invalid_token') {
    super(message);
    this.name = 'InvalidTokenError';
  }
}

export class LIOSAccessControl {
  /**
   * 验证 token，返回 AccessContext 或抛 InvalidTokenError。
   *
   * 查询：SELECT tenant_id, source_app FROM lios_access_tokens
   *      WHERE token = $1 AND is_active = true
   */
  async verify(token: string): Promise<AccessContext> {
    const row = await queryOne<{ tenant_id: string; source_app: string }>(
      `SELECT tenant_id, source_app FROM lios_access_tokens
       WHERE token = $1 AND is_active = true`,
      [token],
    );
    if (!row) {
      throw new InvalidTokenError();
    }
    return Object.freeze({
      tenant_id: row.tenant_id,
      source_app: row.source_app,
    });
  }
}
