/**
 * TokenManager — 第三方平台凭证管理
 *
 * 真实实现职责：
 *   1. 启动时从 lios_tenants.metadata 或独立 secrets 表加载每租户的 Shopee/Lazada 凭证
 *   2. 定时刷新 access_token：
 *      - Shopee：access_token 约 4 小时过期，需用 refresh_token 调
 *        POST /api/v2/auth/access_token/get 续期；refresh_token 30 天有效
 *      - Lazada：access_token **每 6 个月**强制重授权（refresh 仅延期 30 天，到期必须商户重走 OAuth）
 *   3. 到期前 N 天告警租户管理员（邮件 / Slack / dashboard banner）
 *   4. 失败时自动暂停该租户的 Channel/Verifier 调用，避免雪崩
 *
 * Phase 1 只做接口与占位，所有方法抛 NotImplementedError。
 */

import { NotImplementedError, Platform } from '../channels/types';

export interface PlatformCredentials {
  tenant_id:        string;
  platform:         Platform;
  shop_id:          string;
  market?:          'SG' | 'TH' | 'MY' | 'VN' | 'PH' | 'ID';   // 仅 Lazada 用

  partner_id?:      string;     // Shopee
  partner_key?:     string;     // Shopee — 签名密钥，永不出库到日志
  app_key?:         string;     // Lazada
  app_secret?:      string;     // Lazada — 签名密钥

  access_token:     string;
  refresh_token?:   string;     // Shopee 用
  expires_at:       string;     // ISO timestamp
  refresh_expires_at?: string;  // Lazada 6 个月硬上限
}

export interface ExpiringCredential {
  tenant_id:    string;
  platform:     Platform;
  shop_id:      string;
  expires_at:   string;
  days_left:    number;
  needs_action: 'auto_refresh' | 'manual_reauth';
}

export interface TokenManager {
  /** 取出指定租户在指定平台的当前可用凭证（含 access_token） */
  getCredentials(tenant_id: string, platform: Platform, market?: string): Promise<PlatformCredentials>;

  /** 用 refresh_token 主动刷新一次（Shopee）。Lazada 6 个月 reauth 不能自动，会抛错让上层走 manual flow */
  refresh(tenant_id: string, platform: Platform, market?: string): Promise<PlatformCredentials>;

  /** 写入 / 更新凭证（OAuth 回调后调用） */
  upsert(creds: PlatformCredentials): Promise<void>;

  /** 列出 N 天内将到期 / 已到期需要告警的凭证 */
  notifyExpiringSoon(daysAhead: number): Promise<ExpiringCredential[]>;
}

export class StubTokenManager implements TokenManager {
  async getCredentials(_tenant_id: string, _platform: Platform, _market?: string): Promise<PlatformCredentials> {
    throw new NotImplementedError('StubTokenManager.getCredentials not implemented in this phase');
  }
  async refresh(_tenant_id: string, _platform: Platform, _market?: string): Promise<PlatformCredentials> {
    throw new NotImplementedError('StubTokenManager.refresh not implemented in this phase');
  }
  async upsert(_creds: PlatformCredentials): Promise<void> {
    throw new NotImplementedError('StubTokenManager.upsert not implemented in this phase');
  }
  async notifyExpiringSoon(_daysAhead: number): Promise<ExpiringCredential[]> {
    return [];
  }
}

export const tokenManager: TokenManager = new StubTokenManager();
