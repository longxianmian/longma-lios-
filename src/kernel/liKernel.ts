import { TrustLevel } from '../types/lios';

// Trust level → score multiplier applied by the kernel
const TRUST_MULTIPLIER: Record<TrustLevel, number> = {
  L1: 1.00,   // authoritative / auditable
  L2: 0.95,   // verified signal
  L3: 0.80,   // weak / heuristic
  L4: 0.40,   // unverified / external
};

export type KernelVerdict = 'accept' | 'reject' | 'hold';

export interface KernelPackInput {
  id: string;
  name: string;
  score: number;
}

export interface KernelEvidenceInput {
  id: string;
  trust_level: TrustLevel;
  weight: number;
}

export interface KernelResult {
  verdict: KernelVerdict;
  kernel_score: number;
  selected_pack_id: string;
  selected_pack_name: string;
  reason: string;
  evidence_summary: {
    total: number;
    qualified: number;
    pure_l4: boolean;
    trust_distribution: Record<TrustLevel, number>;
  };
}

/**
 * LI Kernel — 裁决函数
 *
 * accept 条件：pack.score >= 0.85  AND  存在至少一条 L1/L2/L3 证据
 * reject 条件：所有证据均为 L4（纯 L4 不具备决策效力）
 * hold  条件：其余情况（score 不足或有效证据为零）
 */
export function runKernel(
  packs: KernelPackInput[],
  evidence: KernelEvidenceInput[]
): KernelResult {
  const dist: Record<TrustLevel, number> = { L1: 0, L2: 0, L3: 0, L4: 0 };
  evidence.forEach(e => dist[e.trust_level]++);

  const qualified     = evidence.filter(e => e.trust_level !== 'L4');
  const hasQualified  = qualified.length > 0;
  const allL4         = evidence.length > 0 && qualified.length === 0;

  const evidenceSummary = {
    total:             evidence.length,
    qualified:         qualified.length,
    pure_l4:           allL4,
    trust_distribution: dist,
  };

  // Sort by pack.score descending; kernel adopts the best scoring pack
  const sorted   = [...packs].sort((a, b) => b.score - a.score);
  const best     = sorted[0];
  const kscore   = best.score;

  if (allL4) {
    return {
      verdict:            'reject',
      kernel_score:       kscore,
      selected_pack_id:   best.id,
      selected_pack_name: best.name,
      reason:             'pure-L4: 所有证据均为 L4，不具备 accept 资格',
      evidence_summary:   evidenceSummary,
    };
  }

  if (kscore >= 0.85 && hasQualified) {
    return {
      verdict:            'accept',
      kernel_score:       kscore,
      selected_pack_id:   best.id,
      selected_pack_name: best.name,
      reason:             `score=${kscore.toFixed(4)} ≥ 0.85 且存在 ${qualified.length} 条 L1/L2/L3 有效证据`,
      evidence_summary:   evidenceSummary,
    };
  }

  const holdReason = kscore < 0.85
    ? `score=${kscore.toFixed(4)} < 0.85，评分不足暂缓`
    : '有效证据数量不足，暂缓等待补充';

  return {
    verdict:            'hold',
    kernel_score:       kscore,
    selected_pack_id:   best.id,
    selected_pack_name: best.name,
    reason:             holdReason,
    evidence_summary:   evidenceSummary,
  };
}
