import { pool } from './client';

const DDL_V2 = `
-- ═══════════════════════════════════════════════════════════════
-- LIOS P0  Schema V2 — 增量 ALTER TABLE，幂等执行
-- ═══════════════════════════════════════════════════════════════

-- 1. lios_intents: trace_id（每次 run 的全局追踪 ID）
ALTER TABLE lios_intents
  ADD COLUMN IF NOT EXISTS trace_id UUID NOT NULL DEFAULT gen_random_uuid();

CREATE UNIQUE INDEX IF NOT EXISTS idx_lios_intents_trace ON lios_intents(trace_id);

-- 2. lios_candidate_packs: state（生命周期状态），source_type（规则来源）
ALTER TABLE lios_candidate_packs
  ADD COLUMN IF NOT EXISTS state TEXT NOT NULL DEFAULT '-1';
ALTER TABLE lios_candidate_packs
  ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'mock_rule';

-- 3. lios_evidence_items: trust_level（L1-L4 信任等级），weight（权重）
ALTER TABLE lios_evidence_items
  ADD COLUMN IF NOT EXISTS trust_level TEXT NOT NULL DEFAULT 'L2';
ALTER TABLE lios_evidence_items
  ADD COLUMN IF NOT EXISTS weight NUMERIC(4,2) NOT NULL DEFAULT 0.85;

DO $$ BEGIN
  ALTER TABLE lios_evidence_items
    ADD CONSTRAINT lios_evidence_trust_level_check
    CHECK (trust_level IN ('L1','L2','L3','L4'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_lios_evidence_trust ON lios_evidence_items(trust_level);

-- 4. lios_decisions: 扩展三态 + hold_count 计数器
ALTER TABLE lios_decisions
  ADD COLUMN IF NOT EXISTS hold_count INTEGER NOT NULL DEFAULT 0;

-- 删除旧 CHECK（decision_type），重建以支持 accept / hold
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT constraint_name
    FROM   information_schema.table_constraints
    WHERE  table_name      = 'lios_decisions'
      AND  constraint_type = 'CHECK'
      AND  constraint_name LIKE '%decision_type%'
  LOOP
    EXECUTE 'ALTER TABLE lios_decisions DROP CONSTRAINT IF EXISTS ' || quote_ident(r.constraint_name);
  END LOOP;
END $$;

DO $$ BEGIN
  ALTER TABLE lios_decisions
    ADD CONSTRAINT lios_decisions_decision_type_v2_check
    CHECK (decision_type IN ('accept','reject','hold','approve','defer','escalate'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 5. lios_actions: idempotency_key（幂等键，全局唯一）
ALTER TABLE lios_actions
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

DO $$ BEGIN
  ALTER TABLE lios_actions
    ADD CONSTRAINT lios_actions_idempotency_key_unique UNIQUE (idempotency_key);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_lios_actions_ikey ON lios_actions(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- 6. lios_intents: 扩展 status CHECK 以覆盖新状态
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT constraint_name FROM information_schema.table_constraints
    WHERE table_name = 'lios_intents' AND constraint_type = 'CHECK'
      AND constraint_name LIKE '%status%'
  LOOP
    EXECUTE 'ALTER TABLE lios_intents DROP CONSTRAINT IF EXISTS ' || quote_ident(r.constraint_name);
  END LOOP;
END $$;

DO $$ BEGIN
  ALTER TABLE lios_intents
    ADD CONSTRAINT lios_intents_status_v2_check
    CHECK (status IN ('pending','processing','decided','completed','failed','accepted','held','rejected'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 7. lios_ledgers: 扩展 event_type CHECK 以覆盖新事件
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT constraint_name FROM information_schema.table_constraints
    WHERE table_name = 'lios_ledgers' AND constraint_type = 'CHECK'
      AND constraint_name LIKE '%event_type%'
  LOOP
    EXECUTE 'ALTER TABLE lios_ledgers DROP CONSTRAINT IF EXISTS ' || quote_ident(r.constraint_name);
  END LOOP;
END $$;

DO $$ BEGIN
  ALTER TABLE lios_ledgers
    ADD CONSTRAINT lios_ledgers_event_type_v2_check
    CHECK (event_type IN (
      'intent.created','pack.created','evidence.added',
      'kernel.scored',
      'decision.made','decision.hold_escalated',
      'action.created','action.executed','action.idempotent_hit',
      'ledger.closed'
    ));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
`;

async function migrateV2() {
  const client = await pool.connect();
  try {
    console.log('[migrate-v2] Applying LIOS P0 schema V2 enhancements...');
    await client.query(DDL_V2);
    console.log('[migrate-v2] Done. New columns: trace_id / state / source_type / trust_level / weight / hold_count / idempotency_key');
  } catch (err) {
    console.error('[migrate-v2] Failed:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrateV2();
