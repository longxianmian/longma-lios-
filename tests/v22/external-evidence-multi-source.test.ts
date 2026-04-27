/**
 * α-5+ Q6 补 1：external_evidence 多 source 场景测试。
 *
 * 验证：DecideRequest.external_evidence 支持多 source（mock_order_verifier + 其他）。
 * 多 source 同时存在时：
 *   - 每个 source 都被 service 处理（不漏）
 *   - augmentDecisionFromExternalEvidence 优先级稳定（mock_order_verifier 触发 verifier 路径）
 *   - 未来加新 source 时不破坏现有行为
 */

import 'dotenv/config';
import { strict as assert } from 'node:assert';
import { LIOSGovernanceService } from '../../src/service/LIOSGovernanceService';
import type { DecideRequest, ExternalEvidence } from '../../src/service/types';
import { injectMockLLM } from './_mock-llm';

const service = new LIOSGovernanceService();
injectMockLLM(service);

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
  source_app: 'multi-source-test',
  session_id: 'multi-1',
  user_message: '我想退貨，訂單號 100001',
  language: 'zh-TW',
  channel: 'demo',
});

(async () => {
  // ───────────────────────────────────────────────────────────────────────────
  // C1: 单 source（mock_order_verifier）→ verifier 路径生效
  // ───────────────────────────────────────────────────────────────────────────
  await run('C1 单 source mock_order_verifier → verifier 信号填充', async () => {
    const ev: ExternalEvidence[] = [{
      source: 'mock_order_verifier',
      type: 'order_verification',
      data: { classification: 'exists_belongs_in_period', order_id: '100001', summary: 'order_lookup: in_period' },
      confidence: 1.0,
    }];
    const r = await service.decide({ ...baseReq, external_evidence: ev });
    assert.equal(r.ledger_payload.order_verifier_classification, 'exists_belongs_in_period');
    assert.equal(r.ledger_payload.order_verifier_id, '100001');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // C2: 多 source（mock_order_verifier + asset_system）→ verifier 仍优先；asset 不破坏 verifier 路径
  // ───────────────────────────────────────────────────────────────────────────
  await run('C2 多 source 共存 → mock_order_verifier 仍优先生效', async () => {
    const ev: ExternalEvidence[] = [
      {
        source: 'mock_order_verifier',
        type: 'order_verification',
        data: { classification: 'exists_belongs_overdue', order_id: '100002', summary: 'order_lookup: overdue' },
        confidence: 1.0,
      },
      {
        source: 'asset_system',
        type: 'supply_pack',
        data: {
          items: [{ name: 'X9', content: '价格 NT$ 4,990' }],
        },
        confidence: 0.9,
      },
    ];
    const r = await service.decide({ ...baseReq, external_evidence: ev });
    assert.equal(r.ledger_payload.order_verifier_classification, 'exists_belongs_overdue');
    assert.equal(r.ledger_payload.order_verifier_id, '100002');
    // bounds.must 应含 verifier overdue 标签
    const hasOverdueTag = r.bounds.must.some(m => m.startsWith('state_order_overdue_with_return_deadline:'));
    assert.ok(hasOverdueTag, `期望 bounds.must 含 state_order_overdue_with_return_deadline:*；实得 ${r.bounds.must.join(',')}`);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // C3: 未知 source 不破坏决策
  // ───────────────────────────────────────────────────────────────────────────
  await run('C3 未知 source（google_maps）不破坏 service.decide', async () => {
    const ev: ExternalEvidence[] = [
      {
        source: 'google_maps',
        type: 'places_search',
        data: { results: [{ name: 'X9 store', rating: 4.5 }] },
        confidence: 0.85,
      },
    ];
    const r = await service.decide({ ...baseReq, external_evidence: ev });
    // 未知 source → verifier 信号为 null（不误判）
    assert.equal(r.ledger_payload.order_verifier_classification, null);
    assert.equal(r.ledger_payload.order_verifier_id, null);
    // 但 service 仍正常 decide
    assert.ok(['accept', 'hold', 'reject'].includes(r.verdict));
  });

  // ───────────────────────────────────────────────────────────────────────────
  // C4: 空 external_evidence 数组 → 无 verifier 信号
  // ───────────────────────────────────────────────────────────────────────────
  await run('C4 空 external_evidence → order_verifier_* 全 null', async () => {
    const r = await service.decide({ ...baseReq, external_evidence: [] });
    assert.equal(r.ledger_payload.order_verifier_classification, null);
    assert.equal(r.ledger_payload.order_verifier_id, null);
    assert.equal(r.ledger_payload.order_verifier_summary, null);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // C5: external_evidence 字段缺失 / undefined → service 不抛错
  // ───────────────────────────────────────────────────────────────────────────
  await run('C5 external_evidence undefined → 不抛错 + 无 verifier 信号', async () => {
    const { external_evidence: _ee, ...reqNoEv } = baseReq as any;
    const r = await service.decide(reqNoEv);
    assert.equal(r.ledger_payload.order_verifier_classification, null);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // C6: 同 source 多条（异常情况）→ 第一条 verifier 信号生效（不报错）
  // ───────────────────────────────────────────────────────────────────────────
  await run('C6 重复 source（异常情况）→ 第一条生效', async () => {
    const ev: ExternalEvidence[] = [
      {
        source: 'mock_order_verifier',
        type: 'order_verification',
        data: { classification: 'wrong_shop', order_id: '100005' },
        confidence: 1.0,
      },
      {
        source: 'mock_order_verifier',
        type: 'order_verification',
        data: { classification: 'not_found', order_id: '787678' },
        confidence: 1.0,
      },
    ];
    const r = await service.decide({ ...baseReq, external_evidence: ev });
    // 取第一条
    assert.equal(r.ledger_payload.order_verifier_classification, 'wrong_shop');
    assert.equal(r.ledger_payload.order_verifier_id, '100005');
  });

  console.log(`\n📊 external_evidence 多 source：${pass}/${total} 通过`);
  process.exit(pass === total ? 0 : 1);
})().catch(e => {
  console.error('runner 异常：', e);
  process.exit(2);
});
