// ── Core enumerations ────────────────────────────────────────────────────────

export type TrustLevel   = 'L1' | 'L2' | 'L3' | 'L4';
export type PackState    = '-1' | '0' | '1';           // unscored / rejected / selected
export type IntentStatus = 'pending' | 'processing' | 'accepted' | 'held' | 'rejected' | 'failed';
export type DecisionType = 'accept' | 'reject' | 'hold';
export type ActionStatus = 'pending' | 'running' | 'done' | 'failed';
export type LedgerEvent  =
  | 'intent.created'
  | 'pack.created'
  | 'evidence.added'
  | 'kernel.scored'
  | 'decision.made'
  | 'decision.hold_escalated'
  | 'action.created'
  | 'action.executed'
  | 'action.idempotent_hit'
  | 'ledger.closed';

// ── DB row interfaces ────────────────────────────────────────────────────────

export interface LiosIntent {
  id: string;
  trace_id: string;
  session_id: string;
  raw_input: string;
  parsed_goal: Record<string, unknown>;
  status: IntentStatus;
  created_at: Date;
  updated_at: Date;
}

export interface LiosCandidatePack {
  id: string;
  intent_id: string;
  name: string;
  description: string;
  score: number;
  state: PackState;
  source_type: string;
  metadata: Record<string, unknown>;
  created_at: Date;
}

export interface LiosEvidenceItem {
  id: string;
  type: string;
  source: string;
  content: string;
  trust_level: TrustLevel;
  weight: number;
  metadata: Record<string, unknown>;
  created_at: Date;
}

export interface LiosEvidencePackIndex {
  id: string;
  pack_id: string;
  evidence_id: string;
  relevance_score: number;
  created_at: Date;
}

export interface LiosDecision {
  id: string;
  intent_id: string;
  pack_id: string;
  decision_type: DecisionType;
  rationale: string;
  confidence: number;
  hold_count: number;
  metadata: Record<string, unknown>;
  created_at: Date;
}

export interface LiosAction {
  id: string;
  decision_id: string;
  action_type: string;
  payload: Record<string, unknown>;
  status: ActionStatus;
  idempotency_key: string | null;
  executed_at: Date | null;
  created_at: Date;
}

export interface LiosLedger {
  id: string;
  entity_type: string;
  entity_id: string;
  event_type: LedgerEvent;
  payload: Record<string, unknown>;
  created_at: Date;
}

// ── Plugin types ─────────────────────────────────────────────────────────────

export type PluginType       = 'llm' | 'tool' | 'retrieval';
export type PluginOutputRole = 'candidate' | 'evidence';
export type PluginStatus     = 'active' | 'disabled';
export type InvocationStatus = 'ok' | 'error' | 'timeout';
export type AssetType        = 'document' | 'policy' | 'knowledge' | 'template' | 'data';
export type AssetScope       = 'industry' | 'enterprise' | 'project' | 'task' | 'role';

export interface LiosPlugin {
  id:          string;
  tenant_id:   string;
  name:        string;
  description: string;
  plugin_type: PluginType;
  endpoint:    string;
  config:      Record<string, unknown>;
  output_role: PluginOutputRole;
  status:      PluginStatus;
  created_at:  Date;
  updated_at:  Date;
}

export interface LiosPluginInvocation {
  id:          string;
  tenant_id:   string;
  plugin_id:   string;
  intent_id:   string | null;
  input:       Record<string, unknown>;
  output:      Record<string, unknown>;
  output_role: PluginOutputRole;
  latency_ms:  number | null;
  status:      InvocationStatus;
  error_msg:   string | null;
  created_at:  Date;
}

export interface LiosAsset {
  id:          string;
  tenant_id:   string;
  name:        string;
  content:     string;
  asset_type:  AssetType;
  scope:       AssetScope;
  scope_ref:   string;
  tags:        string[];
  metadata:    Record<string, unknown>;
  is_indexed:  boolean;
  created_at:  Date;
  updated_at:  Date;
}

// ── API shapes ───────────────────────────────────────────────────────────────

export interface RunRequest {
  tenant_id?:  string;
  intent:      string;
  session_id?: string;
  context?:    Record<string, unknown>;
}

export interface RunResponse {
  trace_id: string;
  intent_id: string;
  session_id: string;
  final_state: 'accepted' | 'rejected' | 'held';
  result: {
    kernel: {
      score: number;
      verdict: string;
      reason: string;
      selected_pack: string;
      evidence_summary: {
        total: number;
        qualified: number;
        pure_l4: boolean;
        trust_distribution: Record<TrustLevel, number>;
      };
    };
    decision: {
      id: string;
      type: DecisionType;
      hold_count: number;
      rationale: string;
      confidence: number;
    };
    actions: Array<{
      id: string;
      type: string;
      idempotency_key: string;
      status: ActionStatus;
      is_new: boolean;
      payload: Record<string, unknown>;
    }>;
    ledger_entries: number;
  };
  processed_at: string;
}
