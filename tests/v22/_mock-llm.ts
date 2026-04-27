/**
 * Mock LLM 套件 —— v2.2 α-4 等价性测试用。
 *
 * 设计：把 service 内部组件的 LLM 调用替换为 deterministic fixture。
 * 实施方式：在测试文件内通过 `(service as any).extractor = mockExtractor` 等
 *           方式替换 service 的 private readonly 字段（运行时仍可写）。
 *
 * 不动业务组件代码（ClaimExtractor / BoundedLLMGenerator / BoundsAuditor）任何一行。
 *
 * Mock 行为：
 *   - 同 input → 同 output（严格 deterministic）
 *   - 输出尽量贴近 v2.1 真实 LLM 抽样的常见结果（让对抗 case 期望仍能命中）
 */

import type { Claim } from '../../src/extractor/ClaimExtractor';
import type { Decision } from '../../src/kernel/v2_1/LIKernel';
import type { AuditResult } from '../../src/auditor/BoundsAuditor';
import type { LastSystemQuestion } from '../../src/runtime/ConversationProjection';

// ─────────────────────────────────────────────────────────────────────────────
// Mock ClaimExtractor
// ─────────────────────────────────────────────────────────────────────────────

export class MockClaimExtractor {
  async extract(
    userInput: string,
    ctx: { last_system_question?: LastSystemQuestion | null; tenant_id?: string; trace_id?: string; active_track?: 'dissatisfaction_track' | 'order_track' | 'inquiry_track' | null } = {},
  ): Promise<Claim[]> {
    const lc = userInput.toLowerCase();

    const c = (
      type: Claim['type'],
      content: Record<string, unknown> = {},
      target?: string,
    ): Claim =>
      Object.freeze({
        type,
        content: Object.freeze(content),
        evidence_source: 'user_assertion' as const,
        confidence: 0.85,
        ...(target ? { target } : {}),
      }) as Claim;

    // 简短肯定 + pending → meta.confirmation
    if (/^(对|對|是|是的|嗯|好|好的|正确|正確)$/i.test(userInput.trim())) {
      const t = ctx.last_system_question?.target_slot ?? ctx.last_system_question?.target_action;
      if (t) return [c('meta.confirmation', { confirmed: true }, t)];
      return [c('chitchat', { sample: userInput.slice(0, 30) })];
    }

    // 闲聊
    if (/(下雪|天气|天氣|风景|風景|你好|hello)/i.test(userInput) &&
        !/(订单|訂單|退货|退貨|买|買|价格|價格|品牌)/i.test(userInput)) {
      return [c('chitchat', { sample: userInput.slice(0, 30) })];
    }

    // 外部服务
    if (/(订餐|訂餐|foodpanda|外送|grab|订机票|帮.{0,2}叫|叫快递)/i.test(userInput)) {
      return [c('external_service.request', { what: userInput.slice(0, 30) })];
    }

    const out: Claim[] = [];

    // 订单号抽取（4-8 位数字 + "订单/訂單" 上下文）
    const orderIdMatch = userInput.match(/(?:订单|訂單|order)\s*[:：]?\s*(\d{4,10})|(\d{6,10})/);
    const orderId = orderIdMatch?.[1] ?? orderIdMatch?.[2];
    if (orderId) {
      out.push(c('order.query', { order_id: orderId }));
    }

    // 退款 / 退货
    if (/(退货|退貨|退款|退还|退錢|不要了)/i.test(userInput)) {
      out.push(c('refund.request', { reason: userInput.slice(0, 30) }));
    }

    // 过去购买含义
    if (/(之前|上次|上个月|上個月|前几天|前幾天|曾经|我买|我買)/i.test(userInput)) {
      const productMatch = userInput.match(/(?:之前|上次|上个月|上個月|前几天|前幾天|曾经|我买|我買)[过的了]?[一台个樣個]?(.{1,8}?)(?:[，。！？,.!?\?]|不|是|有|怎|很|現|现|$)/);
      const what = productMatch?.[1]?.trim();
      out.push(c('purchase.assertion', what ? { what } : {}));
    }

    // 缺陷
    if (/(坏|壞|不能用|不行|有问题|有問題|残次品|殘次品|质量|質量|不制冷|无法开机|無法開機)/i.test(userInput)) {
      const productMatch = userInput.match(/(?:我.{0,3}买|我買|的)\s*(.{1,10}?)(?:不|是|有|很|残|殘|坏|壞|质|質)/);
      const what = productMatch?.[1]?.trim();
      const detailMatch = userInput.match(/(残次品|殘次品|质量有问题|質量有問題|不制冷|无法开机|無法開機|坏了|壞了)/);
      const detail = detailMatch?.[1];
      out.push(c('defect.assertion', { ...(what ? { what } : {}), ...(detail ? { detail } : {}) }));
      // OI-005 修 2：defect 隐含 refund.request（confidence 降一档）
      if (!out.some(x => x.type === 'refund.request')) {
        out.push(c('refund.request', { reason: detail ?? '缺陷' }));
      }
    }

    // 转人工
    if (/(人工|客服|联系人|聯繫人|找人|尽快帮我处理|盡快幫我處理|麻烦.{0,4}处理|麻煩.{0,4}處理)/i.test(userInput)) {
      out.push(c('escalation.request', {}));
    }

    // 询问产品 / 价格
    const productInquiry = userInput.match(/X9|龍碼|龙码|蛋仔|手環|手环/i);
    if (productInquiry) {
      const isPriceQuery = /(多少钱|多少錢|价格|價格|售价|售價)/i.test(userInput);
      if (isPriceQuery) {
        out.push(c('inquiry.price', { product_name: productInquiry[0] }));
      } else if (/(怎么升级|怎麼升級|防水|续航|續航|功能)/i.test(userInput)) {
        out.push(c('inquiry.product', { product_name: productInquiry[0] }));
      }
    }

    // 单纯能力问询
    if (/(能不能|能否|可以.{0,4}吗|可以.{0,4}嗎)/i.test(userInput) &&
        /(传照片|傳照片|发图|發圖|拍照)/i.test(userInput)) {
      out.push(c('inquiry.capability', { what: 'upload_photo' }));
    }

    // 兜底：无法识别
    if (out.length === 0) {
      // 看上下文：active_track + 含糊催促
      if (ctx.active_track === 'dissatisfaction_track' &&
          /(尽快|盡快|快点|快點|麻烦|麻煩)/i.test(userInput)) {
        out.push(c('escalation.request', {}));
      } else if (/^[a-z\s]{1,30}$/i.test(userInput) || userInput.length < 3) {
        out.push(c('meta.unclear', { sample: userInput }));
      } else {
        out.push(c('unknown.business', { sample: userInput.slice(0, 30) }));
      }
    }

    return out;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Mock BoundedLLMGenerator
// ─────────────────────────────────────────────────────────────────────────────

interface MockGenInput {
  user_input: string;
  decision: Decision;
  [k: string]: unknown;
}

interface MockGenOutput {
  reply: string;
  raw: string;
  latency_ms: number;
  tokens_input?: number;
  tokens_output?: number;
}

export class MockBoundedLLMGenerator {
  async generate(input: MockGenInput): Promise<MockGenOutput> {
    const v = input.decision.verdict;
    const must = input.decision.bounds.must;

    // 等价性测试核心：基于 verdict + must 标签 deterministic 出 reply
    let reply: string;
    if (v === 'reject') {
      reply = '抱歉，這部分不在本店業務範圍；如果您有產品或服務相關的問題，歡迎告訴我。';
    } else if (v === 'hold') {
      // pending_slot 决定追问方向
      const ps = input.decision.bounds.pending_slot;
      if (ps === 'order_id') {
        reply = '請您提供訂單編號（以便我們核對本店紀錄），謝謝。';
      } else if (ps === 'refund_reason') {
        reply = '請您提供退貨原因，以便進一步處理。';
      } else if (ps === 'clarified_intent') {
        reply = '請問您想了解或處理什麼呢？';
      } else if (ps === 'complaint_summary') {
        reply = '請您具體描述需要轉人工處理的問題，我會幫您安排。';
      } else if (must.some(m => m.startsWith('clarify_product_name_first:'))) {
        reply = '您是否能具體描述一下產品的特徵呢？';
      } else if (must.some(m => m.startsWith('state_order_overdue_with_return_deadline:'))) {
        reply = '很抱歉，該訂單已超過退貨期，無法處理退貨。';
      } else if (must.some(m => m.startsWith('state_order_already_returned:'))) {
        reply = '系統記錄顯示該訂單已退貨，無法重複處理。';
      } else if (must.includes('ask_user_to_re_confirm_order_number')) {
        reply = '請您再確認訂單編號是否正確。';
      } else {
        reply = '請您提供更多資訊以便我協助您。';
      }
    } else {
      // accept
      if (must.some(m => m.startsWith('state_order_exists_and_in_return_window:'))) {
        reply = '訂單已核驗確認存在且仍在退貨期，包含「龍碼Pro智能手環 X9」，金額 NT$ 4,990。請問您退貨原因是什麼？';
      } else {
        reply = '龍碼Pro智能手環 X9 售價 NT$ 4,990。';
      }
    }

    return Object.freeze({
      reply,
      raw: reply,
      latency_ms: 1,
      tokens_input: 0,
      tokens_output: 0,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Mock BoundsAuditor
// ─────────────────────────────────────────────────────────────────────────────

export class MockBoundsAuditor {
  async audit(input: { reply: string; decision: Decision }): Promise<AuditResult> {
    // mock 不做 retry；直接以 structural 通过返回（mock generator 已保证不违反 must_not）
    return Object.freeze({
      passed: true,
      layer: 'structural' as const,
      final_text: input.reply,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 一键 mock 注入 LIOSGovernanceService 全部 LLM 组件
// ─────────────────────────────────────────────────────────────────────────────

export function injectMockLLM(service: object): void {
  const s = service as Record<string, unknown>;
  s.extractor = new MockClaimExtractor();
  s.generator = new MockBoundedLLMGenerator();
  s.auditor = new MockBoundsAuditor();
}
