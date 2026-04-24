import { FastifyInstance } from 'fastify';
import OpenAI from 'openai';
import { query } from '../db/client';
import { embedText, rankBySimilarity } from '../services/embedding';
import { runKernel } from '../kernel/liKernel';
import { TrustLevel } from '../types/lios';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const TEST_QUESTIONS = [
  '你们的退货政策是什么？',
  '我的订单在哪里？',
  '今天股市怎么样？',
];

// ── Path A: raw GPT, no KB, no kernel ────────────────────────────────────────

async function runPathA(question: string) {
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: '你是一個電商客服助手，請直接回答用戶問題。用繁體中文回覆，不超過 150 字。',
      },
      { role: 'user', content: question },
    ],
    max_tokens: 300,
    temperature: 0.7,
  });

  return {
    reply:      completion.choices[0]?.message?.content?.trim() ?? '(无回复)',
    has_source: false,
    risk:       '可能幻觉/无法追溯',
  };
}

// ── Path B: full LIOS pipeline (no DB writes — read-only compare) ─────────────

async function runPathB(question: string, tenantId: string) {
  // ── 1. KB vector search ───────────────────────────────────────────────────
  const withVec = await query<{
    id: string; name: string; content: string; asset_type: string; embedding: number[];
  }>(
    `SELECT id, name, content, asset_type, embedding FROM lios_assets
     WHERE tenant_id=$1 AND is_indexed=TRUE AND embedding IS NOT NULL
       AND content NOT LIKE '[待转录：%'`,
    [tenantId]
  ).catch(() => [] as { id: string; name: string; content: string; asset_type: string; embedding: number[] }[]);

  let kbAssets: { id: string; name: string; content: string; asset_type: string; similarity?: number }[] = [];

  if (withVec.length > 0) {
    try {
      const queryVec = await embedText(question);
      kbAssets = rankBySimilarity(queryVec, withVec, 5).filter(a => a.similarity > 0.3);
    } catch {
      kbAssets = await query<{ id: string; name: string; content: string; asset_type: string }>(
        `SELECT id, name, content, asset_type FROM lios_assets
         WHERE tenant_id=$1 AND is_indexed=TRUE AND content NOT LIKE '[待转录：%' LIMIT 5`,
        [tenantId]
      ).catch(() => []);
    }
  }

  const kbContext = kbAssets.length > 0
    ? kbAssets.map(a => `【${a.name}】\n${a.content.slice(0, 500)}`).join('\n\n')
    : '';

  // ── 2. Intent analysis ────────────────────────────────────────────────────
  const intentCompletion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: `你是專業電商客服AI。根據下方知識庫判斷用戶問題的意圖與可回答性。

${kbContext ? `知識庫內容：\n${kbContext}` : '（知識庫目前為空）'}

返回 JSON：
{
  "intent_type": "product_inquiry|order_inquiry|return_request|price_inquiry|greeting|complaint|other",
  "intent_summary": "一句話描述",
  "confidence": 0.87,
  "out_of_scope": false
}`,
      },
      { role: 'user', content: question },
    ],
    response_format: { type: 'json_object' },
    max_tokens: 200,
    temperature: 0.2,
  });

  const raw        = JSON.parse(intentCompletion.choices[0]?.message?.content ?? '{}');
  const intentType = (raw.intent_type as string) ?? 'other';
  const confidence = typeof raw.confidence === 'number' ? Math.max(0, Math.min(1, raw.confidence)) : 0.5;
  const outOfScope = raw.out_of_scope === true;
  const candidateScore = outOfScope ? 0.10 : confidence;

  // ── 3. Evidence (in-memory, no DB writes) ─────────────────────────────────
  const evidence: { id: string; trust_level: TrustLevel; weight: number }[] = [];

  if (outOfScope || confidence < 0.5) {
    evidence.push({ id: 'ev-l4-1', trust_level: 'L4', weight: 0.40 });
    evidence.push({ id: 'ev-l4-2', trust_level: 'L4', weight: 0.40 });
  } else {
    evidence.push({ id: 'ev-l2-session', trust_level: 'L2', weight: 0.85 });
    for (const asset of kbAssets) {
      evidence.push({ id: `ev-l3-${asset.id.slice(0, 8)}`, trust_level: 'L3', weight: 0.80 });
    }
  }

  // ── 4. LI Kernel decision ─────────────────────────────────────────────────
  const kernelResult = runKernel(
    [{ id: 'cmp-pack', name: 'compare-test-pack', score: candidateScore }],
    evidence
  );

  // ── 5. Hallucination guard ────────────────────────────────────────────────
  let verdict           = kernelResult.verdict;
  let hallucinationGuard = false;

  if (verdict === 'accept' && kbAssets.length === 0) {
    verdict            = 'hold';
    hallucinationGuard = true;
  }

  // ── 6. Generate reply ─────────────────────────────────────────────────────
  let replyText: string;

  if (verdict === 'accept') {
    const groundedCompletion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `你是企業專屬智能客服，只能根據以下知識庫內容回答用戶問題。

=== 知識庫內容 ===
${kbContext}
=== 知識庫結束 ===

硬性約束：
- 只使用知識庫中明確記載的資訊，禁止推測或補充。
- 知識庫內容與問題無關時，必須回覆：「我目前沒有關於這個問題的資料，請聯繫人工客服。」
- 回覆繁體中文，不超過 150 字。`,
        },
        { role: 'user', content: question },
      ],
      max_tokens: 300,
      temperature: 0.2,
    });
    replyText = groundedCompletion.choices[0]?.message?.content?.trim()
      ?? '我目前沒有關於這個問題的資料，請聯繫人工客服。';
  } else {
    const isFinalReject = verdict === 'reject';
    const fallbackCompletion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: isFinalReject
            ? '你是電商客服助理。這個問題超出服務範圍，請用繁體中文禮貌說明無法回答，並建議聯繫人工客服（LINE：@lios-support）。不超過 80 字。'
            : '你是電商客服助理。用戶問題資訊不足，請用繁體中文友善地追問需要哪些資訊。不超過 80 字。',
        },
        { role: 'user', content: question },
      ],
      max_tokens: 200,
      temperature: 0.4,
    });
    replyText = fallbackCompletion.choices[0]?.message?.content?.trim()
      ?? (isFinalReject ? '此問題超出服務範圍，請聯繫人工客服。' : '請提供更多資訊。');
  }

  const sourceIds = kbAssets.map(a => a.id.slice(0, 8)).join(', ');

  return {
    intent_type:         intentType,
    confidence,
    kb_hits:             kbAssets.length,
    kernel_decision:     verdict,
    kernel_score:        kernelResult.kernel_score,
    hallucination_guard: hallucinationGuard,
    reply:               replyText,
    source:              verdict === 'accept' && sourceIds ? `知识库资产: [${sourceIds}]` : '无',
    traceable:           true,
  };
}

// ── Route ─────────────────────────────────────────────────────────────────────

export async function compareTestRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { tenant_id?: string; q?: string } }>(
    '/lios/compare-test',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            tenant_id: { type: 'string' },
            q:         { type: 'string' },
          },
        },
      },
    },
    async (req, reply) => {
      const tenantId = req.query.tenant_id ?? 'demo';
      const questions = req.query.q
        ? [req.query.q]
        : TEST_QUESTIONS;

      app.log.info({ tenantId, count: questions.length }, '[compare-test] starting');

      // Run all questions; within each question run both paths concurrently
      const results = await Promise.all(
        questions.map(async (question) => {
          const [pathA, pathB] = await Promise.all([
            runPathA(question).catch(err => ({
              reply: `Path A error: ${err instanceof Error ? err.message : String(err)}`,
              has_source: false,
              risk: '调用失败',
            })),
            runPathB(question, tenantId).catch(err => ({
              intent_type: 'error', confidence: 0, kb_hits: 0,
              kernel_decision: 'error', kernel_score: 0,
              hallucination_guard: false,
              reply: `Path B error: ${err instanceof Error ? err.message : String(err)}`,
              source: '无', traceable: false,
            })),
          ]);

          return {
            question,
            without_kernel: pathA,
            with_kernel:    pathB,
          };
        })
      );

      return reply.code(200).send({
        tenant_id:    tenantId,
        tested_at:    new Date().toISOString(),
        total:        results.length,
        results,
      });
    }
  );
}
