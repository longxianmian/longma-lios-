/**
 * Biaodian Policy — LIOS v2.2 工程占位
 *
 * 当前为 LIOS v2.2 γ-4 阶段创建的占位骨架, 用于:
 * 1. 验证 "DB → registry → service" 机制对真实产品应用 tenant 工作
 * 2. 为标典 SaaS 启动后预留 tenant 槽位
 *
 * ⚠️ 真实业务规则待"标典 P0"工程阶段定义.
 *    届时应通过 migrate_v14+ 替换本文件内容, 而不修改 LIOS 内核.
 *
 * 占位策略关键设计 (保守设置, 防止占位被误用产生输出):
 * - out_of_scope_default = 'reject': 占位 tenant 任何越界都直接拒绝
 * - escalation_threshold = 1: 任何歧义立即升级, 不自作主张
 * - candidate_action_templates = []: 占位 tenant 不参与 action resolve
 * - slot_definitions = {}: 占位 tenant 无业务 slot
 *
 * 这些设置确保占位 tenant 调用 LIOS 时:
 *   - 不会崩溃 (类型合法、字段齐全)
 *   - 不会产生有意义的业务输出 (都拒绝/升级)
 */

import type { ClaimType } from '../../extractor/ClaimExtractor';
import type { TenantPolicy } from '../TenantPolicy';

export const BiaodianPolicy: TenantPolicy = Object.freeze({
  tenant_id: 'biaodian-demo',
  industry: 'biaodian',

  // 选 2 个最 meta 最普适的 ClaimType:
  // - meta.unclear: 处理用户输入完全无法解析 (任何 tenant 都需要兜底)
  // - unknown.business: 处理业务越界 (占位 tenant 没业务范围, 一切都越界)
  // 不选 meta.confirmation/negation: 它们依赖 last_system_question, 占位 tenant 没有
  recognized_claim_types: Object.freeze<ClaimType[]>([
    'meta.unclear',
    'unknown.business',
  ]),

  slot_definitions: Object.freeze({}),

  candidate_action_templates: Object.freeze([]),

  escalation_threshold: 1,

  forbidden_commitments: Object.freeze([]),

  // 最宽松 BoundsTemplate (3 个 string array 全空):
  // - must:     [] 不强制任何输出特征
  // - must_not: [] 不禁止任何输出
  // - may:      [] 不暗示任何可选行为
  // 占位 tenant candidate_action_templates=[] 已保证 LIOS pipeline 不会调 LLM 生成 reply,
  // bounds_template 字段实际不会被检验, "宽松"不影响实际行为, 仅类型合法占位。
  bounds_template: Object.freeze({
    must: Object.freeze([]),
    must_not: Object.freeze([]),
    may: Object.freeze([]),
  }),

  reject_claim_types: Object.freeze<ClaimType[]>([]),
  out_of_scope_default: 'reject',
});
