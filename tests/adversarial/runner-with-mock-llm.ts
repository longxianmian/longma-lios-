/**
 * v2.2 退化判断锚点（B-4 决议）：mock LLM 下跑 22 case。
 *
 * 设计原则：
 *   - 不经 HTTP，直接调 LIOSGovernanceService.decide()
 *   - 用 _mock-llm.ts 替换 service 内部 LLM 组件（deterministic 输出）
 *   - 真实 mockOrderVerifier 仍保留（数据库读 = deterministic）
 *   - 校验 verdict_legacy + scope（不校验 reply text，因为 reply 由 mock 模板生成）
 *
 * 期望：22/22 deterministic 通过——同样输入永远同样结果。
 *
 * 跑法：npx tsx tests/adversarial/runner-with-mock-llm.ts [S1 S2 ...]
 */

import 'dotenv/config';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { LIOSGovernanceService } from '../../src/service/LIOSGovernanceService';
import type { DecideRequest, ProjectionSnapshot, ExternalEvidence } from '../../src/service/types';
import { ConversationProjection } from '../../src/runtime/ConversationProjection';
import { mockOrderVerifier } from '../../src/verifiers/MockOrderVerifier';
import { summarizeVerification } from '../../src/verifiers/types';
import { createTestService } from '../v22/_test-helpers';

interface CaseDef {
  id: string;
  label: string;
  turns: string[];
  expected_verdicts?: Array<number | null>;
  expected_scope_contains_any?: string[];
  preconditions?: string[];
}

interface TurnResult {
  user: string;
  verdict_legacy: number;
  verdict_new: string;
  scope: string[];
}

interface CaseResult {
  id: string;
  label: string;
  passed: boolean;
  failures: string[];
  turns: TurnResult[];
}

// ─────────────────────────────────────────────────────────────────────────────
// 装载 case
// ─────────────────────────────────────────────────────────────────────────────

async function loadCases(filter: ReadonlyArray<string>): Promise<CaseDef[]> {
  const dir = path.resolve(__dirname, 'cases');
  const files = await fs.readdir(dir);
  const cases: CaseDef[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const content = await fs.readFile(path.join(dir, f), 'utf-8');
    const c = JSON.parse(content) as CaseDef;
    if (filter.length === 0 || filter.includes(c.id)) {
      cases.push(c);
    }
  }
  cases.sort((a, b) => {
    const an = parseInt(a.id.replace(/^S/, ''), 10);
    const bn = parseInt(b.id.replace(/^S/, ''), 10);
    return an - bn;
  });
  return cases;
}

// ─────────────────────────────────────────────────────────────────────────────
// 模拟 ConversationRuntime 的 verifier 包装 + 调 service.decide 流程
// ─────────────────────────────────────────────────────────────────────────────

async function runTurn(
  service: LIOSGovernanceService,
  session_id: string,
  message: string,
  projection: ConversationProjection,
): Promise<{ result: any; nextProjection: ConversationProjection }> {
  // 抽 claims（用 service 内的 mock extractor）
  // 但这里我们让 service 自己抽（不传 pre_extracted_claims），mock extractor 已注入
  // 唯一例外：runtime 在调 verifier 前也需要 claim 来检测 order.query
  // 解法：先用 service.extractor 抽一次（mock）作为 verifier 触发判断的依据

  // 拿到 mock extractor
  const extractor = (service as any).extractor;
  const claims = await extractor.extract(message, {
    last_system_question: projection.last_system_question,
    tenant_id: 'demo',
  });

  // 检测 order.query → 调真实 verifier → 包装 ExternalEvidence
  const externalEvidence: ExternalEvidence[] = [];
  const orderClaim = claims.find((c: any) => c.type === 'order.query');
  if (orderClaim) {
    const oid = orderClaim.content.order_id;
    if (typeof oid === 'string' && oid.length > 0) {
      try {
        const v = await mockOrderVerifier.verifyByOrderId(oid, {
          tenant_id: 'demo', shop_id: 'demo',
        });
        externalEvidence.push({
          source: 'mock_order_verifier',
          type: 'order_verification',
          data: {
            classification: v.classification,
            order_id: oid,
            summary: summarizeVerification(v),
          },
          confidence: 1.0,
        });
      } catch { /* verifier 不可用 */ }
    }
  }

  // 调 service.decide
  const req: DecideRequest = {
    tenant_id: 'demo',
    source_app: 'mock-runner',
    session_id,
    user_message: message,
    language: 'zh-TW',
    channel: 'demo',
    pre_extracted_claims: claims,
    external_evidence: externalEvidence,
    projection_snapshot: projection as unknown as ProjectionSnapshot,
  };
  const result = await service.decide(req);

  // 模拟 projection.appendEntry（律 2 累计写入端）
  const family = result.ledger_payload.dominant_family;
  const attemptKey = family !== 'unknown' ? `family:${family}` : undefined;
  const seq = projection.computed_from_ledger_seq + 1;
  const nextProjection = projection.appendEntry({
    seq,
    event_type: 'kernel.scored',
    conversation_id: session_id,
    tenant_id: 'demo',
    entity_type: 'intent',
    entity_id: `e-${seq}`,
    created_at: new Date().toISOString(),
    payload: { attempt_key: attemptKey, verdict: result.verdict, runtime: 'v2_1' },
    claims: null,
    evidence_pack: null,
    bounds: null,
    action_id: null,
    action_status: null,
  });

  return { result, nextProjection };
}

// ─────────────────────────────────────────────────────────────────────────────
// 跑单 case
// ─────────────────────────────────────────────────────────────────────────────

async function runCase(c: CaseDef): Promise<CaseResult> {
  const service = createTestService();

  const session_id = `mock-${c.id}-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
  let projection = ConversationProjection.empty(session_id, 'demo');
  const turns: TurnResult[] = [];
  const failures: string[] = [];

  for (let i = 0; i < c.turns.length; i++) {
    const msg = c.turns[i];
    const { result, nextProjection } = await runTurn(service, session_id, msg, projection);
    projection = nextProjection;

    const tr: TurnResult = {
      user: msg,
      verdict_legacy: result.verdict_legacy,
      verdict_new: result.verdict,
      scope: result.ledger_payload.pre_kernel_bridge.pre_scope as string[],
    };
    turns.push(tr);

    // 校验 verdict
    const expV = c.expected_verdicts?.[i];
    if (expV !== undefined && expV !== null) {
      if (tr.verdict_legacy !== expV) {
        failures.push(`T${i + 1} verdict: expected=${expV} got=${tr.verdict_legacy}`);
      }
    }
  }

  // 校验 scope（取最后一 turn 的 scope）
  if (c.expected_scope_contains_any && c.expected_scope_contains_any.length > 0) {
    const lastScope = turns[turns.length - 1]?.scope ?? [];
    const ok = c.expected_scope_contains_any.some(exp => lastScope.includes(exp));
    if (!ok) {
      failures.push(`scope: expected any of ${JSON.stringify(c.expected_scope_contains_any)} got ${JSON.stringify(lastScope)}`);
    }
  }

  return {
    id: c.id,
    label: c.label,
    passed: failures.length === 0,
    failures,
    turns,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────────────────────────

(async () => {
  const filter = process.argv.slice(2);
  const cases = await loadCases(filter);

  console.log(`mock-LLM 22 case runner · ${cases.length} cases`);
  console.log('━'.repeat(72));

  const results: CaseResult[] = [];
  for (const c of cases) {
    const r = await runCase(c);
    results.push(r);
    const sym = r.passed ? '✅' : '❌';
    console.log(`${sym} ${c.id} ${c.label}`);
    if (!r.passed) {
      for (const f of r.failures) console.log(`     ${f}`);
      console.log(`     turns:`);
      for (const t of r.turns) {
        console.log(`       USER: ${t.user}`);
        console.log(`         v_legacy=${t.verdict_legacy}  v_new=${t.verdict_new}  scope=${JSON.stringify(t.scope)}`);
      }
    }
  }

  const passed = results.filter(r => r.passed).length;
  console.log('━'.repeat(72));
  console.log(`mock-LLM 22 case 通过率：${passed}/${results.length}`);

  process.exit(passed === results.length ? 0 : 1);
})().catch(e => {
  console.error('runner 异常：', e);
  process.exit(2);
});
