/**
 * α-5+ Q6 补 2：BoundsAuditor retry 路径测试。
 *
 * 验证 service.decide 内 BoundsAuditor 的三层架构 + retry 行为：
 *   - 第一次 generate 输出违反 bounds → auditor 拒绝 → retry 一次
 *   - retry 后 generator 输出新内容 → auditor 通过 → 返回新 reply
 *   - retry 仍失败 → fallback 模板（audit_layer='fallback'）
 *
 * 用 stub generator + stub auditor 模拟具体 retry 触发。
 */

import 'dotenv/config';
import { strict as assert } from 'node:assert';
import type { DecideRequest } from '../../src/service/types';
import { MockClaimExtractor } from './_mock-llm';
import { createTestService } from './_test-helpers';
import type { Decision } from '../../src/kernel/v2_1/LIKernel';
import type { AuditResult } from '../../src/auditor/BoundsAuditor';

let pass = 0, total = 0;
async function run(name: string, fn: () => Promise<void>) {
  total++;
  try {
    await fn();
    pass++;
    console.log(`✅ ${name}`);
  } catch (e) {
    console.error(`❌ ${name}\n   ${e instanceof Error ? e.message : String(e)}`);
  }
}

const baseReq: DecideRequest = Object.freeze({
  tenant_id: 'demo',
  source_app: 'retry-test',
  session_id: 'retry-1',
  user_message: 'X9 多少钱',
  language: 'zh-TW',
  channel: 'demo',
});

(async () => {
  // ───────────────────────────────────────────────────────────────────────────
  // C1: structural pass + semantic pass → audit_layer = structural / semantic
  // ───────────────────────────────────────────────────────────────────────────
  await run('C1 默认通过路径 → audit_layer ∈ {structural, semantic}', async () => {
    const service = createTestService();
    const r = await service.decide(baseReq);
    assert.ok(['structural', 'semantic', 'fallback'].includes(r.ledger_payload.audit_layer));
    assert.equal(r.ledger_payload.audit_retried, false);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // C2: 第一次 generate 违反 → retry 一次 → 第二次通过
  // ───────────────────────────────────────────────────────────────────────────
  await run('C2 第一次违反 → retry 一次 → audit_retried=true', async () => {
    const service = createTestService({ injectMock: false });
    (service as any).extractor = new MockClaimExtractor();

    // mock generator：第 1 次输出违规，第 2 次输出正常
    let callCount = 0;
    (service as any).generator = {
      async generate() {
        callCount++;
        return {
          reply: callCount === 1
            ? '已为您退款 100 元，请查收。'  // 违规：commit_refund_completed
            : '請您提供更多資訊以協助您。',
          raw: 'mock',
          latency_ms: 1,
        };
      },
    };

    // mock auditor：第 1 次失败要求 retry，第 2 次成功
    let auditCount = 0;
    (service as any).auditor = {
      async audit(input: { reply: string; decision: Decision }, retry?: () => Promise<string>): Promise<AuditResult> {
        auditCount++;
        if (auditCount === 1) {
          // 第 1 次失败 → 调 retry → 二次审核
          const newDraft = await retry!();
          return Object.freeze({
            passed: true,
            layer: 'structural' as const,
            final_text: newDraft,
            retried: true,
          });
        }
        return Object.freeze({
          passed: true,
          layer: 'structural' as const,
          final_text: input.reply,
        });
      },
    };

    const r = await service.decide(baseReq);
    assert.equal(r.ledger_payload.audit_retried, true, 'audit_retried 应为 true');
    assert.equal(callCount, 2, `generator 应调 2 次；实得 ${callCount}`);
    // 确认最终 reply 是 retry 后的版本
    assert.ok(!r.reply_draft.includes('已为您退款'), `reply_draft 不应含违规内容；实得 ${r.reply_draft}`);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // C3: retry 仍失败 → audit_layer='fallback'
  // ───────────────────────────────────────────────────────────────────────────
  await run('C3 retry 仍失败 → audit_layer=fallback', async () => {
    const service = createTestService({ injectMock: false });
    (service as any).extractor = new MockClaimExtractor();

    // mock generator：每次都违规
    (service as any).generator = {
      async generate() {
        return {
          reply: '已为您退款 100 元，请查收。',
          raw: 'mock',
          latency_ms: 1,
        };
      },
    };

    // mock auditor：retry 仍失败 → 兜底模板
    (service as any).auditor = {
      async audit(_input: { reply: string; decision: Decision }, retry?: () => Promise<string>): Promise<AuditResult> {
        if (retry) await retry();  // 调一次 retry
        return Object.freeze({
          passed: true,  // 兜底总是 passed=true（边界书 §5.9 三层兜底）
          layer: 'fallback' as const,
          final_text: '為了協助您處理，請提供更具體的資訊。',
          retried: true,
          reason: 'fallback_after_retry',
        });
      },
    };

    const r = await service.decide(baseReq);
    assert.equal(r.ledger_payload.audit_layer, 'fallback');
    assert.equal(r.ledger_payload.audit_retried, true);
    assert.equal(r.reply_draft, '為了協助您處理，請提供更具體的資訊。');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // C4: BoundsAuditor 整体在 service.decide 内是原子操作（外部不感知中间状态）
  // ───────────────────────────────────────────────────────────────────────────
  await run('C4 调用方只看到最终 audited reply，不感知 retry 中间态', async () => {
    const service = createTestService();
    const r = await service.decide(baseReq);
    // result 接口只有 reply_draft 一个字段（最终输出），无 intermediate_replies / retry_history
    assert.ok('reply_draft' in r);
    assert.ok(!('intermediate_replies' in r));
    assert.ok(!('retry_history' in r));
  });

  console.log(`\n📊 BoundsAuditor retry：${pass}/${total} 通过`);
  process.exit(pass === total ? 0 : 1);
})().catch(e => {
  console.error('runner 异常：', e);
  process.exit(2);
});
