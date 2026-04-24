import { pool } from './client';

const DDL = `
-- LIOS P0 Schema — 龙码协议 7张核心表

CREATE TABLE IF NOT EXISTS lios_intents (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    TEXT NOT NULL,
  raw_input     TEXT NOT NULL,
  parsed_goal   JSONB NOT NULL DEFAULT '{}',
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','processing','decided','completed','failed')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lios_intents_session ON lios_intents(session_id);
CREATE INDEX IF NOT EXISTS idx_lios_intents_status  ON lios_intents(status);

-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS lios_candidate_packs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id   UUID NOT NULL REFERENCES lios_intents(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  score       NUMERIC(5,4) NOT NULL DEFAULT 0 CHECK (score >= 0 AND score <= 1),
  metadata    JSONB NOT NULL DEFAULT '{}',
  status      TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','rejected','selected')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lios_packs_intent ON lios_candidate_packs(intent_id);

-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS lios_evidence_items (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type       TEXT NOT NULL CHECK (type IN ('fact','rule','signal','constraint','prior')),
  source     TEXT NOT NULL,
  content    TEXT NOT NULL,
  metadata   JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lios_evidence_type ON lios_evidence_items(type);

-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS lios_evidence_pack_index (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pack_id          UUID NOT NULL REFERENCES lios_candidate_packs(id) ON DELETE CASCADE,
  evidence_id      UUID NOT NULL REFERENCES lios_evidence_items(id) ON DELETE CASCADE,
  relevance_score  NUMERIC(5,4) NOT NULL DEFAULT 1 CHECK (relevance_score >= 0 AND relevance_score <= 1),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (pack_id, evidence_id)
);

CREATE INDEX IF NOT EXISTS idx_lios_epi_pack     ON lios_evidence_pack_index(pack_id);
CREATE INDEX IF NOT EXISTS idx_lios_epi_evidence ON lios_evidence_pack_index(evidence_id);

-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS lios_decisions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id     UUID NOT NULL REFERENCES lios_intents(id) ON DELETE CASCADE,
  pack_id       UUID NOT NULL REFERENCES lios_candidate_packs(id),
  decision_type TEXT NOT NULL CHECK (decision_type IN ('approve','reject','defer','escalate')),
  rationale     TEXT NOT NULL DEFAULT '',
  confidence    NUMERIC(5,4) NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 1),
  metadata      JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lios_decisions_intent ON lios_decisions(intent_id);

-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS lios_actions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_id UUID NOT NULL REFERENCES lios_decisions(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL,
  payload     JSONB NOT NULL DEFAULT '{}',
  status      TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','running','done','failed')),
  executed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lios_actions_decision ON lios_actions(decision_id);
CREATE INDEX IF NOT EXISTS idx_lios_actions_status   ON lios_actions(status);

-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS lios_ledgers (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type TEXT NOT NULL,
  entity_id   UUID NOT NULL,
  event_type  TEXT NOT NULL CHECK (event_type IN (
                'intent.created','pack.created','evidence.added',
                'decision.made','action.created','action.executed','ledger.closed')),
  payload     JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lios_ledgers_entity ON lios_ledgers(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_lios_ledgers_event  ON lios_ledgers(event_type);
`;

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('[migrate] Running LIOS P0 DDL...');
    await client.query(DDL);
    console.log('[migrate] All 7 tables created/verified.');
  } catch (err) {
    console.error('[migrate] Failed:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
