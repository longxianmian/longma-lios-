/**
 * v11 — lios_trace_links 表（v2.2 Phase β-3）
 *
 * trace_id 跨系统关联：把 LIOS 内部 lios_trace_id 与应用方 app_trace_id
 * 对齐，便于排错与审计。
 *
 * 字段：
 *   lios_trace_id  TEXT PRIMARY KEY   — LIOS API 路由生成的 trace_id（randomUUID v4）
 *   app_trace_id   TEXT NULL          — 应用方传入的 trace（β 阶段 body 自报，可空）
 *   source_app     TEXT NOT NULL DEFAULT 'unknown'  — γ-5 后从 token 取
 *   tenant_id      TEXT NOT NULL
 *   created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
 *
 * 索引：
 *   idx_lios_trace_links_app    (source_app, app_trace_id)  — 应用方反查
 *   idx_lios_trace_links_tenant (tenant_id, created_at DESC) — 租户审计
 *
 * 回滚：见 migrate_v11_down.ts
 */

import 'dotenv/config';
import { pool } from './client';

const DDL_V11 = `
CREATE TABLE IF NOT EXISTS lios_trace_links (
  lios_trace_id TEXT        PRIMARY KEY,
  app_trace_id  TEXT,
  source_app    TEXT        NOT NULL DEFAULT 'unknown',
  tenant_id     TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lios_trace_links_app
  ON lios_trace_links (source_app, app_trace_id);
CREATE INDEX IF NOT EXISTS idx_lios_trace_links_tenant
  ON lios_trace_links (tenant_id, created_at DESC);
`;

async function run() {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(DDL_V11);
    await c.query('COMMIT');
    console.log('✅ migrate_v11 done — lios_trace_links');
  } catch (e) {
    await c.query('ROLLBACK');
    console.error('❌ migrate_v11 failed:', e);
    process.exitCode = 1;
  } finally {
    c.release();
    await pool.end();
  }
}

run();
