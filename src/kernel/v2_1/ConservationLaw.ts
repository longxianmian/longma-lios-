/**
 * 律 2：账本守恒律（Ledger Conservation Law） — 白皮书 §4.2
 *
 * > 已 committed 的 Action 不被重复触发。系统状态由不可篡改的账本独一定义。
 *
 * 工程归约（白皮书 §4.4 物理律之外的工程化推导）：
 *   - 每个候选 action 须有可推导的 action_id（T7 ActionResolver 实际生成）
 *   - 若账本里同 action_id 已 committed → 返回引用，不再生成新 action
 *   - 升级阈值（"事不过三"）按 **intent_family** 累计 **turn 数** 而非 action_type
 *     原因：用户三轮换不同措辞请求同一目标是常态（"退货"→"取消订单"→"不要了"）；
 *     按 action_type 累计会永远触发不了升级。
 *   - intent_family 由 action_type → family 的结构化映射决定（不写关键词）
 *
 * 律内核：
 *   - 不持有 tenant；只接收 projection + 候选 actions + 阈值
 *   - 实际的 action_id 与外部核验由 ActionResolver 在 T7 处理
 *   - 这里只判断"等价 action 是否已 committed" + "intent_family 累计是否超阈值"
 */

import type { CandidateAction } from '../../builder/CandidatePackBuilder';
import type { ConversationProjection, PendingAction } from '../../runtime/ConversationProjection';

/**
 * Intent family 分类：把语义相近的目标聚合为一个簇。
 * 累计计数按 family，不按 action_type。
 *
 * 未列出的 action_type 默认归 'unknown'（不参与 escalation 累计）。
 *
 * 当前映射针对电商租户；T11 之后可考虑搬到 TenantPolicy。
 */
export const ACTION_FAMILY: Readonly<Record<string, string>> = Object.freeze({
  // dissatisfaction_track —— 用户对某商品/订单有不满需要处理
  'refund.initiate':       'dissatisfaction_track',
  'handoff.transfer':      'dissatisfaction_track',
  'escalation.intake':     'dissatisfaction_track',
  'purchase.verify':       'dissatisfaction_track',
  'defect.collect_proof':  'dissatisfaction_track',

  // order_track —— 单纯订单查询
  'order.lookup':          'order_track',

  // inquiry_track —— 产品/价格/能力问询
  'inquiry.answer':        'inquiry_track',
  'capability.deflect':    'inquiry_track',

  // meta_track —— 澄清类
  'intent.clarify':        'meta_track',
});

export function familyFor(action_type: string): string {
  return ACTION_FAMILY[action_type] ?? 'unknown';
}

export interface CommittedReference {
  readonly action_id: string;
  readonly action_type: string;
  readonly committed_at_seq: number;
}

export interface ConservationLawResult {
  readonly violated: boolean;
  readonly reason: string;
  readonly already_committed?: ReadonlyArray<CommittedReference>;
  readonly repeated_pending?: ReadonlyArray<{ action_id: string; count: number }>;
  readonly should_escalate?: boolean;
}

export interface ConservationContext {
  readonly projection: ConversationProjection | null;
  readonly escalation_threshold: number;       // 来自 TenantPolicy
}

export class ConservationLaw {
  /**
   * 评估候选 action 是否与账本守恒。
   *
   * 注意：T6 时还没有真实的 action_id（T7 ActionResolver 才生成）。
   * 这一层先做"基于投影的等价识别"——
   *   - 若候选 action 的 action_type+target_object_id 已经 committed → reference existing
   *   - 同 action 在 pending 计数 ≥ escalation_threshold → 触发升级建议
   */
  evaluate(
    candidate_actions: ReadonlyArray<CandidateAction>,
    ctx: ConservationContext,
  ): ConservationLawResult {
    const proj = ctx.projection;
    if (!proj) {
      return Object.freeze({ violated: false, reason: 'no_projection' });
    }

    const already_committed: CommittedReference[] = [];
    const repeated_pending: { action_id: string; count: number }[] = [];

    for (const ca of candidate_actions) {
      // 1) 已 committed 的等价 action（用 action_type + target_object_id 作 fingerprint）
      const committedMatch = matchCommitted(proj.committed_actions, ca);
      if (committedMatch) {
        already_committed.push({
          action_id: committedMatch.action_id,
          action_type: committedMatch.action_type,
          committed_at_seq: committedMatch.created_seq,
        });
        continue;
      }

      // 2) pending 同 action 反复（保留 action_type 维度的 pending 信息）
      const pendingMatches = proj.pending_actions.filter(p =>
        equivalent(p, ca),
      );
      if (pendingMatches.length > 0) {
        const total = pendingMatches.length;
        const id = pendingMatches[0].action_id;
        repeated_pending.push({ action_id: id, count: total });
      }
    }

    // 3) intent_family 累计 turn 数（白皮书 §4.4：由律 2 推导出的"事不过三"）
    //    数据源：projection.attempts —— Runtime 每轮写一次 attempt_key=<dominant_family>
    //    当前轮的 candidate_actions 也算 +1（即使本轮还没入账本）
    const familyTurnCounts = new Map<string, number>();
    for (const [key, info] of Object.entries(proj.attempts)) {
      if (key.startsWith('family:')) {
        familyTurnCounts.set(key.slice('family:'.length), info.count);
      }
    }
    const currentTurnFamilies = new Set<string>();
    for (const ca of candidate_actions) {
      const fam = familyFor(ca.action_type);
      if (fam !== 'unknown') currentTurnFamilies.add(fam);
    }
    for (const fam of currentTurnFamilies) {
      familyTurnCounts.set(fam, (familyTurnCounts.get(fam) ?? 0) + 1);
    }

    // 升级仅触发于 dissatisfaction_track（白皮书 §4.4：阈值是工程化推导，不同 family 阈值/语义可异）
    // 其他 family（inquiry / order / meta）的累计 turn 不视为升级条件——
    // 比如用户三次问同一价格，正确做法是"缩短回复"而非升级。
    const escalatingFamily = [...familyTurnCounts.entries()].find(
      ([fam, c]) => fam === 'dissatisfaction_track' && c >= ctx.escalation_threshold,
    );
    const should_escalate = !!escalatingFamily;

    if (already_committed.length > 0) {
      return Object.freeze({
        violated: true,                  // "violated" = 等价 action 已存在；上层应 reference 而非新生成
        reason: 'action_already_committed',
        already_committed: Object.freeze(already_committed),
        ...(repeated_pending.length > 0
          ? { repeated_pending: Object.freeze(repeated_pending) }
          : {}),
        ...(should_escalate ? { should_escalate: true } : {}),
      });
    }

    if (should_escalate) {
      return Object.freeze({
        violated: false,
        reason: `family_threshold_reached:${escalatingFamily![0]}:${escalatingFamily![1]}`,
        repeated_pending: Object.freeze(repeated_pending),
        should_escalate: true,
      });
    }

    return Object.freeze({
      violated: false,
      reason: repeated_pending.length > 0 ? 'pending_within_threshold' : 'ok',
      ...(repeated_pending.length > 0
        ? { repeated_pending: Object.freeze(repeated_pending) }
        : {}),
    });
  }
}

function matchCommitted(
  committed: ReadonlyArray<PendingAction>,
  ca: CandidateAction,
): PendingAction | undefined {
  return committed.find(c => equivalent(c, ca));
}

function equivalent(p: PendingAction, ca: CandidateAction): boolean {
  if (p.action_type !== ca.action_type) return false;
  // target_object_id 比对：通过 action_id 可能编码也可能不编码 target；
  // T7 真正生成 action_id 后这一步会更精确。当前以 action_type 等价为主。
  return true;
}
