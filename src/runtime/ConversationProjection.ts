/**
 * ConversationProjection — v2.1 派生视图（白皮书 §6.2 / §6.3）
 *
 * 架构纪律（不可写原则 / Read-Only Projection Principle）：
 *   1. 投影只能由 Ledger 记录"折叠"出来；不暴露任何 setter
 *   2. 任何"修改"都返回新实例，原实例 readonly 不可改
 *   3. 字段 readonly + Object.freeze（编译期 + 运行期双保险）
 *   4. 销毁后从同一账本重建必得到完全相等的投影
 *
 * T2 不连接 chat.ts —— 由 T10 ConversationRuntime 接入。
 */

// ─────────────────────────────────────────────────────────────────────────────
// 基础类型
// ─────────────────────────────────────────────────────────────────────────────

export type SlotStatus = 'pending' | 'filled' | 'rejected';
export type ActionLifecycleStatus = 'pending' | 'committed' | 'cancelled';

export interface Slot {
  readonly name: string;
  readonly value?: unknown;
  readonly status: SlotStatus;
}

export interface PendingAction {
  readonly action_id: string;
  readonly action_type: string;
  readonly status: ActionLifecycleStatus;
  readonly created_seq: number;
}

export interface Attempt {
  readonly key: string;
  readonly count: number;
  readonly last_seq: number;
}

export interface LastSystemQuestion {
  readonly target_slot?: string;
  readonly target_action?: string;
  readonly raised_at_seq: number;
}

/**
 * 单行账本投影输入。所有字段尽量与 lios_ledgers 列对齐，
 * 但只描述 ConversationProjection 真正需要消化的子集。
 */
export interface LedgerRow {
  readonly seq: number;
  readonly event_type: string;
  readonly conversation_id: string;
  readonly tenant_id: string;
  readonly entity_type: string;
  readonly entity_id: string;
  readonly created_at: string | Date;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly claims: ReadonlyArray<Readonly<Record<string, unknown>>> | null;
  readonly evidence_pack: Readonly<Record<string, unknown>> | null;
  readonly bounds: Readonly<Record<string, unknown>> | null;
  readonly action_id: string | null;
  readonly action_status: ActionLifecycleStatus | null;
}

export interface LedgerSummary {
  readonly conversation_id: string;
  readonly tenant_id: string;
  readonly rows: ReadonlyArray<LedgerRow>;     // 必须按 seq 升序
}

// ─────────────────────────────────────────────────────────────────────────────
// ConversationProjection（Readonly Projection）
// ─────────────────────────────────────────────────────────────────────────────

export interface ConversationProjectionShape {
  readonly conversation_id: string;
  readonly tenant_id: string;

  // 推导态（白皮书强调：phase 不再写死，只是推导值）
  readonly inferred_phase: string;
  readonly pending_slots: ReadonlyArray<Slot>;
  readonly filled_slots: ReadonlyArray<Slot>;
  readonly pending_actions: ReadonlyArray<PendingAction>;
  readonly committed_actions: ReadonlyArray<PendingAction>;
  readonly attempts: Readonly<Record<string, Attempt>>;
  readonly verification_history: ReadonlyArray<Readonly<Record<string, unknown>>>;
  readonly last_system_question: LastSystemQuestion | null;

  // 元数据
  readonly computed_from_ledger_seq: number;
  readonly computed_at: number;
}

export class ConversationProjection implements ConversationProjectionShape {
  readonly conversation_id: string;
  readonly tenant_id: string;
  readonly inferred_phase: string;
  readonly pending_slots: ReadonlyArray<Slot>;
  readonly filled_slots: ReadonlyArray<Slot>;
  readonly pending_actions: ReadonlyArray<PendingAction>;
  readonly committed_actions: ReadonlyArray<PendingAction>;
  readonly attempts: Readonly<Record<string, Attempt>>;
  readonly verification_history: ReadonlyArray<Readonly<Record<string, unknown>>>;
  readonly last_system_question: LastSystemQuestion | null;
  readonly computed_from_ledger_seq: number;
  readonly computed_at: number;

  /**
   * 私有构造器 —— 唯一入口是 rebuild() / appendEntry()。
   * 即便 TS 标了 private，外部 ts 编译期也不能直接 new。
   */
  private constructor(state: ConversationProjectionShape) {
    this.conversation_id          = state.conversation_id;
    this.tenant_id                = state.tenant_id;
    this.inferred_phase           = state.inferred_phase;
    this.pending_slots            = freezeArr(state.pending_slots);
    this.filled_slots             = freezeArr(state.filled_slots);
    this.pending_actions          = freezeArr(state.pending_actions);
    this.committed_actions        = freezeArr(state.committed_actions);
    this.attempts                 = Object.freeze({ ...state.attempts });
    this.verification_history     = freezeArr(state.verification_history);
    this.last_system_question     = state.last_system_question
      ? Object.freeze({ ...state.last_system_question })
      : null;
    this.computed_from_ledger_seq = state.computed_from_ledger_seq;
    this.computed_at              = state.computed_at;

    Object.freeze(this);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 构造入口
  // ───────────────────────────────────────────────────────────────────────────

  static empty(conversation_id: string, tenant_id: string): ConversationProjection {
    return new ConversationProjection({
      conversation_id,
      tenant_id,
      inferred_phase: 'fresh',
      pending_slots: [],
      filled_slots: [],
      pending_actions: [],
      committed_actions: [],
      attempts: {},
      verification_history: [],
      last_system_question: null,
      computed_from_ledger_seq: 0,
      computed_at: Date.now(),
    });
  }

  /**
   * 从账本完全重建投影。任何时刻销毁后用同一份 LedgerSummary 调用 rebuild
   * 必得到与之前相等的投影（确定性折叠）。
   */
  static rebuild(summary: LedgerSummary): ConversationProjection {
    let proj = ConversationProjection.empty(summary.conversation_id, summary.tenant_id);
    const ordered = [...summary.rows].sort((a, b) => a.seq - b.seq);
    for (const row of ordered) {
      proj = proj.appendEntry(row);
    }
    return proj;
  }

  /**
   * 增量推进：返回新投影实例（原实例 readonly）。
   * 这是"派生视图绝不独立写入"的工程实现 —— 看起来像 mutate，实际是返回新值。
   */
  appendEntry(row: LedgerRow): ConversationProjection {
    if (row.conversation_id !== this.conversation_id) {
      throw new Error(
        `[ConversationProjection] conversation_id mismatch: projection=${this.conversation_id}, row=${row.conversation_id}`,
      );
    }
    if (row.seq <= this.computed_from_ledger_seq) {
      // 幂等：重复回放同一行不改变状态
      return this;
    }

    const next: MutableShape = {
      conversation_id:          this.conversation_id,
      tenant_id:                this.tenant_id,
      inferred_phase:           this.inferred_phase,
      pending_slots:            [...this.pending_slots],
      filled_slots:             [...this.filled_slots],
      pending_actions:          [...this.pending_actions],
      committed_actions:        [...this.committed_actions],
      attempts:                 { ...this.attempts },
      verification_history:     [...this.verification_history],
      last_system_question:     this.last_system_question
        ? { ...this.last_system_question }
        : null,
      computed_from_ledger_seq: row.seq,
      computed_at:              Date.now(),
    };

    foldRow(next, row);
    return new ConversationProjection(next);
  }

  /**
   * 用于测试：销毁后比较。返回的是一份纯 JSON-safe 快照。
   */
  snapshot(): ConversationProjectionShape {
    return Object.freeze({
      conversation_id:          this.conversation_id,
      tenant_id:                this.tenant_id,
      inferred_phase:           this.inferred_phase,
      pending_slots:            cloneArr(this.pending_slots),
      filled_slots:             cloneArr(this.filled_slots),
      pending_actions:          cloneArr(this.pending_actions),
      committed_actions:        cloneArr(this.committed_actions),
      attempts:                 { ...this.attempts },
      verification_history:     cloneArr(this.verification_history),
      last_system_question:     this.last_system_question
        ? { ...this.last_system_question }
        : null,
      computed_from_ledger_seq: this.computed_from_ledger_seq,
      computed_at:              this.computed_at,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 折叠器：单行账本如何影响投影
// ─────────────────────────────────────────────────────────────────────────────

interface MutableShape {
  conversation_id: string;
  tenant_id: string;
  inferred_phase: string;
  pending_slots: Slot[];
  filled_slots: Slot[];
  pending_actions: PendingAction[];
  committed_actions: PendingAction[];
  attempts: Record<string, Attempt>;
  verification_history: Array<Readonly<Record<string, unknown>>>;
  last_system_question: LastSystemQuestion | null;
  computed_from_ledger_seq: number;
  computed_at: number;
}

function foldRow(state: MutableShape, row: LedgerRow): void {
  // 1) Action 生命周期：依赖 v9 新加的 action_id / action_status
  if (row.action_id && row.action_status) {
    handleActionRow(state, row);
  }

  // 2) Bounds：派生 last_system_question（用于 meta.confirmation 绑定）
  if (row.bounds) {
    const lastQ = extractLastSystemQuestion(row);
    if (lastQ) {
      state.last_system_question = lastQ;
    }
  }

  // 3) Slot：从 payload.slots / claims 推导（T3 之后才会真正写入；
  //          目前作为结构占位，确保规则确定性）
  if (Array.isArray((row.payload as { slots?: unknown }).slots)) {
    const slots = (row.payload as { slots?: Slot[] }).slots ?? [];
    for (const s of slots) {
      promoteSlot(state, s);
    }
  }

  // 4) Verification：如果 payload 含核验记录，追加历史
  const verif = (row.payload as { verification?: unknown }).verification;
  if (verif && typeof verif === 'object') {
    state.verification_history = [
      ...state.verification_history,
      Object.freeze({ ...(verif as Record<string, unknown>), _seq: row.seq }),
    ];
  }

  // 5) Attempts：按 attempt_key 累加（payload.attempt_key 由调用方写入）
  const attemptKey = (row.payload as { attempt_key?: unknown }).attempt_key;
  if (typeof attemptKey === 'string' && attemptKey.length > 0) {
    const prev = state.attempts[attemptKey];
    state.attempts[attemptKey] = {
      key: attemptKey,
      count: (prev?.count ?? 0) + 1,
      last_seq: row.seq,
    };
  }

  // 6) inferred_phase：根据是否有 pending_actions / pending_slots 推导
  state.inferred_phase = inferPhase(state);
}

function handleActionRow(state: MutableShape, row: LedgerRow): void {
  const id = row.action_id!;
  const type = (row.payload as { action_type?: unknown }).action_type;
  const action_type = typeof type === 'string' ? type : 'unknown';

  if (row.action_status === 'pending') {
    if (
      !state.pending_actions.some(a => a.action_id === id) &&
      !state.committed_actions.some(a => a.action_id === id)
    ) {
      state.pending_actions = [
        ...state.pending_actions,
        { action_id: id, action_type, status: 'pending', created_seq: row.seq },
      ];
    }
  } else if (row.action_status === 'committed') {
    state.pending_actions = state.pending_actions.filter(a => a.action_id !== id);
    if (!state.committed_actions.some(a => a.action_id === id)) {
      state.committed_actions = [
        ...state.committed_actions,
        { action_id: id, action_type, status: 'committed', created_seq: row.seq },
      ];
    }
  } else if (row.action_status === 'cancelled') {
    state.pending_actions = state.pending_actions.filter(a => a.action_id !== id);
  }
}

function extractLastSystemQuestion(row: LedgerRow): LastSystemQuestion | null {
  const b = row.bounds as Record<string, unknown>;
  const target_slot = typeof b['pending_slot'] === 'string' ? (b['pending_slot'] as string) : undefined;
  const target_action = typeof b['pending_action'] === 'string' ? (b['pending_action'] as string) : undefined;
  if (!target_slot && !target_action) return null;
  return { target_slot, target_action, raised_at_seq: row.seq };
}

function promoteSlot(state: MutableShape, slot: Slot): void {
  if (slot.status === 'filled') {
    state.pending_slots = state.pending_slots.filter(s => s.name !== slot.name);
    if (!state.filled_slots.some(s => s.name === slot.name)) {
      state.filled_slots = [...state.filled_slots, slot];
    }
  } else if (slot.status === 'pending') {
    if (
      !state.pending_slots.some(s => s.name === slot.name) &&
      !state.filled_slots.some(s => s.name === slot.name)
    ) {
      state.pending_slots = [...state.pending_slots, slot];
    }
  } else if (slot.status === 'rejected') {
    state.pending_slots = state.pending_slots.filter(s => s.name !== slot.name);
  }
}

function inferPhase(state: MutableShape): string {
  if (state.pending_actions.length > 0) return 'awaiting_action';
  if (state.pending_slots.length > 0) return 'collecting_slots';
  if (state.committed_actions.length > 0) return 'post_action';
  if (state.filled_slots.length > 0) return 'slots_ready';
  return 'fresh';
}

// ─────────────────────────────────────────────────────────────────────────────
// 工具
// ─────────────────────────────────────────────────────────────────────────────

function freezeArr<T>(arr: ReadonlyArray<T>): ReadonlyArray<T> {
  return Object.freeze(arr.map(item =>
    typeof item === 'object' && item !== null ? Object.freeze({ ...item }) : item
  )) as ReadonlyArray<T>;
}

function cloneArr<T>(arr: ReadonlyArray<T>): T[] {
  return arr.map(item =>
    typeof item === 'object' && item !== null ? ({ ...item } as T) : item
  );
}
