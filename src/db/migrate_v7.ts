import 'dotenv/config';
import { pool } from './client';

async function run() {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');

    // ── lios_agent_sessions: human handoff sessions ──────────────────────────
    await c.query(`
      CREATE TABLE IF NOT EXISTS lios_agent_sessions (
        id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id          text NOT NULL,
        session_id         text NOT NULL,
        intent_id          uuid REFERENCES lios_intents(id) ON DELETE SET NULL,
        channel            text NOT NULL DEFAULT 'web',
        status             text NOT NULL DEFAULT 'pending',
        assigned_agent_id  text,
        user_id            text,
        reject_reason      text,
        created_at         timestamptz NOT NULL DEFAULT now(),
        updated_at         timestamptz NOT NULL DEFAULT now(),
        closed_at          timestamptz,
        CONSTRAINT agent_sessions_status_chk
          CHECK (status IN ('pending','active','completed','transferred')),
        CONSTRAINT agent_sessions_channel_chk
          CHECK (channel IN ('web','wechat','line','shopee','whatsapp','other'))
      );
    `);
    await c.query(`
      CREATE INDEX IF NOT EXISTS idx_agent_sessions_tenant_status
        ON lios_agent_sessions (tenant_id, status, created_at DESC);
    `);
    await c.query(`
      CREATE INDEX IF NOT EXISTS idx_agent_sessions_session
        ON lios_agent_sessions (session_id);
    `);

    // ── lios_agent_messages: conversation log on the human side ──────────────
    await c.query(`
      CREATE TABLE IF NOT EXISTS lios_agent_messages (
        id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        agent_session_id   uuid NOT NULL REFERENCES lios_agent_sessions(id) ON DELETE CASCADE,
        role               text NOT NULL,
        content            text NOT NULL,
        agent_id           text,
        created_at         timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT agent_messages_role_chk
          CHECK (role IN ('user','agent','system','lios_auto'))
      );
    `);
    await c.query(`
      CREATE INDEX IF NOT EXISTS idx_agent_messages_session_time
        ON lios_agent_messages (agent_session_id, created_at);
    `);

    await c.query('COMMIT');
    console.log('✅ migrate_v7 done — agent_sessions / agent_messages');
  } catch (e) {
    await c.query('ROLLBACK');
    console.error('❌ migrate_v7 failed:', e);
    process.exitCode = 1;
  } finally {
    c.release();
    await pool.end();
  }
}

run();
