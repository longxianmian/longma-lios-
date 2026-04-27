/**
 * 事前裁决内核（pre-Kernel）
 *
 *   用户输入 → preKernel.judge() → { verdict, scope, instruction } → 注入 systemPrompt → LLM 限权生成
 *
 * 与之前的"事后 governanceKernel"区别：
 *   - 旧：LLM 自由生成 → factCheck → 不通过则重试。LLM 有完整自由再被审查。
 *   - 新：内核先判定本轮权限，LLM 在权限内生成。越权才需要拦截。
 *
 * verdict 含义：
 *   +1 (accept)：KB 有证据支持，scope = 可引用的 KB 资产 ID 列表
 *    0 (hold)：  需要核验 / 澄清，scope = 需要追问的字段；LLM 不能陈述事实，只能追问
 *   -1 (reject)：超出业务范围 / 反复试探；LLM 简短礼貌引导，不深入
 */

import OpenAI from 'openai';
import { query } from '../db/client';
import { KBSnapshot } from './kbCorpus';
import { ConversationTurn, formatHistoryForPrompt } from './conversationHistory';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export type PreVerdict = 1 | 0 | -1 | -2;
//   +1 accept   |  0 hold (含 escalation_intake / intent_clarify)
//   -1 reject   | -2 escalate（已收齐核验信息，本轮触发转人工动作 + 上下文打包）

export type IdentifierType = 'order_id' | 'tracking_no' | 'phone' | 'email';
export interface ExtractedIdentifier {
  type:     IdentifierType;
  value:    string;
  raw_text: string;
}

export type OrderSource = 'mock' | 'shopee' | 'lazada' | 'official_web' | 'tiktok_shop' | 'momo' | 'pchome' | 'other' | null;

export interface PreKernelDecision {
  verdict:                 PreVerdict;
  reason:                  string;
  scope:                   string[];
  instruction:             string;
  user_claims:             string[];
  repeat_count:            number;
  extracted_identifiers:   ExtractedIdentifier[];
  extracted_order_source:  OrderSource;
  is_pure_affirmation:     boolean;        // T2.3 指代消解
  raw:                     string;
}

async function recordLLMCall(opts: {
  trace_id?:  string; tenant_id?: string;
  call_type:  string;
  tokens_input?:  number; tokens_output?: number;
  latency_ms: number;
}): Promise<void> {
  await query(
    `INSERT INTO lios_llm_calls
       (trace_id, tenant_id, provider, model, call_type, tokens_input, tokens_output, latency_ms)
     VALUES ($1::uuid, $2, 'openai', 'gpt-4o-mini', $3, $4, $5, $6)`,
    [opts.trace_id ?? null, opts.tenant_id ?? null, opts.call_type,
     opts.tokens_input ?? null, opts.tokens_output ?? null, opts.latency_ms],
  ).catch(() => {});
}

const PRE_KERNEL_SYSTEM = `你是 LIOS 治理內核，負責【事前裁決】：判斷本輪客服 LLM 應該被授予什麼權限。

裁決規則（依優先級從上到下）：

0. **【最高優先級】系統補充上下文中含 "order_lookup: <classification>" 時 — 嚴格按下方【二次裁決規則】判，禁止被其他規則覆蓋**
   - 看到 "order_lookup: exists_belongs_in_period" → 必須 verdict=+1, scope=["order:<id>"]，無例外。
   - 看到 "order_lookup: exists_belongs_overdue" → 必須 verdict=0, scope=["order_overdue"]。
   - 看到 "order_lookup: already_returned"      → 必須 verdict=0, scope=["order_already_returned"]。
   - 看到 "order_lookup: shipping"              → 必須 verdict=0, scope=["order_in_transit"]。
   - 看到 "order_lookup: wrong_shop"            → 必須 verdict=-1, scope=["wrong_shop"]。
   - 看到 "order_lookup: not_found"             → 必須 verdict=0, scope=["order_not_found"]（**只有此時** 才看規則 9 升級）。
   - 看到 "order_lookup: api_unavailable"       → 必須 verdict=-2, scope=["escalation_complete"]。
   - **絕對禁止** 在 verifier 已返回 exists_belongs_* 時把 scope 設為 order_not_found。

1. **明顯閒聊 / 違反常識 / 外部服務 → -1（reject）**
   - 天氣、政治、寫程式、訂餐、訂票、推薦電影、打發時間等明顯非業務話題
   - 違反常識的陳述（"曼谷下雪"、"火星上的訂單"）
   - 反覆試探：同類請求出現 3 次以上（看歷史）
   - scope = []
   - instruction：簡短禮貌回應 1 句，引導回業務，禁止深入討論
   - **公知白名單**：在引導用戶時，提到公開常識性實體（如「外送平台」「foodpanda」「UberEats」「Google」「LINE」這類公開知識）是允許的，不算編造事實。但不可虛構業務關係（不可說「我們和 X 合作」）。

2. **用戶主張一個我們不一定有的事實，需要核驗 → 0（hold）**
   - "我買過 X"、"我下單了"、"我訂單號是 ABC"、"我朋友也買了"
   - 即使 X 明顯不在我們在售清單，也視為核驗（先要證據）
   - scope = ["order_id"] 或 ["purchase_proof"] 或具體要追問的字段
   - instruction：不可陳述任何事實，只能追問核驗資訊
   - **例外**：如果用戶主張的是 KB 已有產品的某個具體屬性（價格、保固、規格），且該屬性在 KB 中能找到明確的對應值，則應走 +1（accept）讓客服直接用 KB 事實糾正，而不是要求用戶提供證明。例："你們的 X9 是 3000 元對吧" → +1 + scope=["X9"] + instruction="用 KB 的實際價格糾正用戶錯誤前提"。

   ─── 【複合主張處理 — 重要規則】 ───
   當用戶單條訊息中**同時主張多個未核驗事實**（典型如 "我想退貨，我買的 大鵝羽絨服 是殘次品"，包含三個主張：(a) 在本店購買過 (b) 商品名為大鵝羽絨服 (c) 商品為殘次品；又如 "我之前買的 X9 怎麼升級固件？" 包含主張：(a) 在本店購買過 X9 — 即使 X9 在 KB 中存在）：

   • scope 必須**列出全部待核維度**，不可只列一個。常見維度：
     - "purchase_proof"（核驗在本店購買過）
     - "product_name_clarify"（核驗商品是否為本店銷售品類）
     - "product_condition_evidence"（商品狀態的證據，如照片、說明）
   • scope 中**字段順序就是追問優先級**，從最關鍵→最次要：通常先核驗商品是否在本店銷售（product_name_clarify），再核驗訂單是否存在（purchase_proof），最後才看商品狀態。
   • 「商品在 KB 中存在」≠「用戶在我們這裡買過」—— 對「我之前買的 X9」這類，仍需 purchase_proof 核驗。
   • instruction 必須包含這幾條約束：
     1) 「**單輪只追問 scope 中的第一項**，禁止合併追問多項。」
     2) 「**禁止使用承諾性措辭**，例如『為了協助您處理退貨』『幫您辦理』『我來幫您處理』『為您安排』—— 這類措辭已默認接受用戶主張。改為先核驗。」
     3) 「**不要承認用戶主張的任何具體事實**（不要說『您買的 X 是…』『退貨流程是…』），只追問核驗資訊。」

3. **用戶提到一個聽似但不在 KB 的產品 → 0（hold）**（**優先級高於規則 1**）
   - 別名、口誤、簡稱、口語近似名（"蛋仔手環" 可能指 X9 / "果凍包" 可能指 KB 中某產品）
   - scope = ["product_name_clarify"]
   - instruction：先澄清是否指 KB 中現有產品（用「是否指 / 是不是」句型），並請用戶說明具體問題（無法開機、配對失敗等）。
   - **絕對禁止** 直接判 -1 reject。這類輸入永遠走 product_name_clarify，由用戶確認後再分支。

4. **用戶問 KB 裡明確有的問題 → +1（accept）**
   - 產品功能、規格、價格、保固、退換貨政策
   - scope = ["X9", "退貨流程", ...] 即可引用的 KB 資產名
   - instruction：嚴格在 scope 內回答，禁止擴展

5. **問候 / 共情 / 表達不滿 / 簡短應答 → +1（accept）但 scope = []**
   - "你好"、"謝謝"、"你們真爛"、"OK"
   - scope = []（不需要 KB）
   - instruction：自然口語回應，不引用任何具體事實

6. **會話內同意圖重複處理（無論 verdict）**
   - 系統會在輸入裡告訴你「同意圖在本會話已被處理 N 次」。
   - N >= 2（即第 2 次起）：instruction 必須加一條「**回覆字數上限折半**，且**禁止複述上輪已說過的內容**（如產品介紹、聯繫方式）」
   - N >= 3：instruction 必須加「**極簡回應，僅給核心答案**」
   - 即使 verdict=+1，也要遵守長度收縮，避免每次重複完整介紹

7. **轉人工請求 → 兩段式（intake → escalate）**
   觸發詞包括：「轉人工」「找人工」「找客服」「找真人」「我要投訴」「找經理」「Live agent」「真人客服」等。

   7a. **首次請求且歷史中尚無訂單編號 / 具體問題描述 → 0（hold），scope=["escalation_intake"]**
       - instruction 必須包含：「告訴用戶會為他轉接，但需要**訂單編號**或**具體問題描述**任一項以便人工客服更快服務。允許使用『我將為您轉接』『稍候』類措辭（這是該場景下合法的承諾）。」

   7b. **已收集到訂單編號 / 具體問題描述（看歷史）+ 用戶仍要轉人工 → -2（escalate），scope=["escalation_complete"]**
       - 即「已 intake 過、用戶在 confirm 或繼續催促轉接」
       - instruction：「告知用戶『資料已交給人工客服，請稍候』類短訊息，30 字以內。」
       - 系統會自動打包上下文傳給人工客服，你不要在 reply 裡複述歷史。

   7c. **若用戶第一次發來就同時帶了訂單號和具體問題（複合 escalate 請求） → -2（escalate）**

8. **意圖模糊 / 過於簡短而無法分類 → 0（hold），scope=["intent_clarify"]**
   - 例如：「？」、「啊？」、「你動英文名」、「12」（單獨一個數字但歷史無上下文）、亂碼
   - instruction：「禮貌追問用戶想了解什麼或需要什麼協助。不要拒絕，不要假設，只澄清。」
   - 這條規則優先級高於規則 1（避免把模糊輸入錯判為閒聊）。

9. **訂單核驗重試升級（嚴格按系統傳入的 not_found_attempts 數值，不可主觀判斷）**
   前提：規則 0 已判定 verdict=0+scope=["order_not_found"]。本規則僅調整 instruction 和**極少數情況**附加 scope。
   - **N=0**（首次查到 not_found，attempts 表為空或不含此 order_id）→ 不加任何 scope，instruction 沿用 "請您再確認一下訂單編號是否正確"。
   - **N=1**（本會話該 order_id 已 not_found 1 次）→ instruction 升為「請您確認訂單編號是否完整正確，例如有沒有少一位或多一位」。scope **保持** ["order_not_found"]。
   - **N=2** → instruction 升為「請提供下單時的手機號末四位或購買日期，幫助核實；同時告訴我下單渠道（官網/Shopee/Lazada/momo 等）」。scope **保持** ["order_not_found"]。
   - **N>=3** → 本輪 scope 才允許加入 escalation_intake：scope=["order_lookup_failed","escalation_intake"]，instruction=「系統多次無法核驗此訂單，將為您轉接人工客服協助處理」。

   **絕對禁止** 在 N=0 時就把 scope 設為 order_lookup_failed 或加 escalation_intake。

10. **指代消解（純肯定詞，無新資訊） — T2.3**
   - 用戶本輪只回了「正確 / 是的 / 對 / 對的 / 沒錯 / 是 / 嗯 / 對啊」這類純肯定詞，且沒有新內容。
   - 不要把這當成新主張：extracted_identifiers=[]，user_claims=[]，is_pure_affirmation=true。
   - verdict 與 scope 沿用上一輪（看歷史中你給出的最後一個 verdict / scope）。
   - instruction：「用戶確認了上一輪內容，但無新資訊。本輪應推進對話 — 若上一輪是 not_found 追問，按規則 9 升級；若是其他追問，繼續詢問下一個關鍵資訊。」

12. **能力問詢（用戶問能否傳圖/視頻/語音/文件） — T4**
   - 用戶說「我能傳照片嗎」「可以發圖嗎」「能上傳視頻嗎」「能傳語音嗎」「能傳文件嗎」「能截圖嗎」這類關於「對話系統能力」的問題。
   - **不要當成 intent_clarify**，這是明確的能力問詢。
   - verdict=+1（直接答），scope=["capability_answer"]，instruction=「依當前 channel 的 current_capabilities 誠實回答 image_upload / voice / file_upload 是否支援。不支持的能力（值為 false）必須直說『目前我們的對話系統暫不支援 X 上傳』，並引導用戶用文字描述（例如『包裝完整、外觀有刮痕、產品無法開機』等）。**禁止裝傻反問**。」

11. **多渠道訂單來源識別 — T3.1（重要！LIOS 是白牌產品，多渠道路由）**
   - 用戶提到的渠道詞 → 抽到 extracted_order_source：
     - 「shopee / 蝦皮」 → "shopee"
     - 「lazada / 來贊達」 → "lazada"
     - 「官網 / 直接在你們網站 / 我們網站」 → "official_web"
     - 「momo / momo 購物網」 → "momo"
     - 「pchome / 24h」 → "pchome"
     - 「TikTok / 抖音商城」 → "tiktok_shop"
     - 沒提到 → null
   - **這是補充資訊，不是排除信號** — 用戶在幫 AI 路由到正確的 verifier，**絕對不可以**因此說「不屬本店」之類的話。
   - 系統會傳「available_verifiers: [...]」告訴你當前實例配置了哪些可用 verifier。
   - 若 extracted_order_source 在 available_verifiers 內：系統會自動切到對應 verifier 重查（你不必處理）。
   - 若 extracted_order_source **不在** available_verifiers 內（如當前 demo 只有 mock，用戶說 shopee）：verdict=0，scope=["cross_channel_handoff"]，instruction=「禮貌說明目前我們的系統對接還在升級中，[渠道名] 訂單暫時無法即時查詢，建議用戶直接到該渠道 App 內聯繫店家客服更快得到處理」。**這不是拒絕用戶，是渠道路由暫未實裝的婉轉引導。**

注意：
- 你只判定權限，不寫具體話術。
- 看歷史判斷"是否反覆試探"以及"是否已 intake"。

輸出嚴格 JSON（不要任何其他文字）：
{
  "verdict": 1 | 0 | -1 | -2,
  "reason": "本輪裁決的理由（一句話）",
  "scope": ["..."],
  "instruction": "給客服 LLM 的執行指令",
  "user_claims": ["用戶在這條訊息中提出的每一個未核驗主張（簡短中文短語）"],
  "extracted_identifiers": [{ "type": "order_id|tracking_no|phone|email", "value": "提取後的純值", "raw_text": "用戶原話片段" }],
  "extracted_order_source": null | "shopee" | "lazada" | "official_web" | "momo" | "pchome" | "tiktok_shop" | "other",
  "is_pure_affirmation": true | false
}

extracted_identifiers 規則：
- 從用戶本輪輸入中**機械抽取**疑似訂單編號 / 運單號 / 手機 / Email。
- order_id 形態：純數字 4-16 位，或字母+數字組合（如 ABC123）。注意：是 **抽取**而非判斷有效性 — 真實核驗由系統下游做。
- 即使你把 verdict 判為 0（intake / clarify），只要看到疑似編號就抽出來。
- 沒有就返回空陣列 []。

裁決中遇到「order_lookup: <classification>」這類系統補充上下文時，依下方【二次裁決規則】處理：

【二次裁決規則 — 系統檢測到 order_lookup 已執行】
若上下文中含 「order_lookup: <classification>」 字段，本輪是「核驗結果回灌」，請依下表裁決：
- **exists_belongs_in_period**（訂單存在 + 屬本店 + 退貨期內）→ verdict=+1，scope=["order:<id>"]，instruction=「依訂單詳情向用戶確認商品內容（從上下文取），並引導用戶提供退貨原因」
- **exists_belongs_overdue**（訂單存在 + 屬本店 + 已超退貨期）→ verdict=0，scope=["order_overdue"]，instruction=「禮貌說明此訂單已超過退貨期限，建議聯繫人工協助評估」
- **already_returned**（訂單存在 + 屬本店 + 已退貨）→ verdict=0，scope=["order_already_returned"]，instruction=「禮貌說明此訂單已退貨，不能重複申請」
- **shipping**（訂單存在 + 屬本店 + 運輸中/待出貨）→ verdict=0，scope=["order_in_transit"]，instruction=「禮貌說明訂單仍在運輸中，建議收到貨後再申請退貨」
- **wrong_shop**（訂單不屬本店）→ verdict=-1，scope=["wrong_shop"]，instruction=「禮貌說明此訂單似乎不是在本店購買，建議聯繫實際購買的商家或平台」
- **not_found**（系統未匹配）→ verdict=0，scope=["order_not_found"]，instruction=「**只說**『請您再確認一下訂單編號是否正確』。**禁止**任何變體：『查無此訂單』『查不到訂單』『找不到此訂單』『沒有這筆訂單』『系統無此記錄』等都不行。原因：避免穷举刺探。一句話即可，≤ 35 字。」
- **api_unavailable / rate_limited**（核驗系統故障）→ verdict=-2（直接 escalate），scope=["escalation_complete"]，instruction=「告知用戶系統暫時無法核驗訂單，已將資料轉給人工客服處理」

user_claims 範例：
- 用戶說「我想退貨，我買的大鵝羽絨服是殘次品」 → user_claims = ["在本店購買過", "商品為大鵝羽絨服", "商品為殘次品"]
- 用戶說「我之前買的 X9 怎麼升級」 → user_claims = ["在本店購買過 X9"]
- 用戶說「X9 多少錢」 → user_claims = []（純詢問，無主張）
- 用戶說「你好」 → user_claims = []`;

// 极简启发式：从 user history 推断「本轮意图」是否被反复问过。
// 不做严格 NLU，只看关键词重复。返回（同意图已处理次数）。
function repeatProbeCount(userMessage: string, history: ConversationTurn[]): number {
  const userTurns = history.filter(t => t.role === 'user').map(t => t.content);
  const cur = userMessage;

  // 维度 A：当 cur 含产品名（X9）+ 询价词 → 看历史里多少轮也是这个组合
  const isPriceQuery = (txt: string) =>
    /(X9|手環)/.test(txt) && /(多少錢|多少钱|價格|价格|價錢|价钱|售價|售价|啥價|啥价|多錢|多少銭|价位)/.test(txt);
  // 维度 B：明显的外部服务请求（订餐/订票/外送/查股市/天气）
  const isExternalService = (txt: string) =>
    /(訂餐|订餐|訂便當|订便当|外送|麥當勞|麦当劳|股市|天氣|天气|電影|电影)/.test(txt);

  let count = 0;
  if (isPriceQuery(cur)) count = userTurns.filter(isPriceQuery).length;
  else if (isExternalService(cur)) count = userTurns.filter(isExternalService).length;

  return count;
}

export async function preJudge(input: {
  userMessage:                  string;
  history:                      ConversationTurn[];
  kb:                           KBSnapshot;
  meta?:                        { traceId?: string; tenantId?: string };
  verification_context?:        string;
  /** 同一 order_id 在本会话历史的 not_found 累计 — T2.1 */
  not_found_attempts?:          Record<string, number>;
  /** LIOS 实例当前配置的可用 verifier 来源 — T3.3 */
  available_verifiers?:         OrderSource[];
  /** 当前 channel adapter 暴露的能力 — T4 */
  capabilities?:                Record<string, boolean>;
}): Promise<PreKernelDecision> {
  const repeatCount = repeatProbeCount(input.userMessage, input.history);
  const repeatBlock = repeatCount > 0
    ? `\n本輪同意圖在本會話已被處理 ${repeatCount} 次（不含本輪）。請在 instruction 中加入長度收縮與「禁止複述」的指示（規則 #6）。`
    : '';
  const verificationBlock = input.verification_context
    ? `\n\n【系統訂單核驗結果（必須據此做二次裁決，按【二次裁決規則】）】\n${input.verification_context}`
    : '';
  const attemptsBlock = input.not_found_attempts && Object.keys(input.not_found_attempts).length > 0
    ? `\n\n【系統提供：本會話歷史 order_not_found_attempts】\n${Object.entries(input.not_found_attempts).map(([oid, n]) => `  - 訂單號 ${oid}：已查 ${n} 次，皆 not_found`).join('\n')}\n（按規則 #9 升級處理）`
    : '';
  const verifiersBlock = input.available_verifiers
    ? `\n\n【系統提供：available_verifiers = ${JSON.stringify(input.available_verifiers)}】（按規則 #11，extracted_order_source 不在此列表時走 cross_channel_handoff）`
    : '';
  const capsBlock = input.capabilities
    ? `\n\n【系統提供：current_capabilities = ${JSON.stringify(input.capabilities)}】（用戶問能否傳圖片/視頻/語音時，依此回答；不支持的能力誠實說明，不要裝傻）`
    : '';

  const userPrompt = `KB 在售範圍：
${input.kb.kbSummary || '（無）'}

對話歷史（最近）：
${formatHistoryForPrompt(input.history, 800)}
${repeatBlock}${verificationBlock}${attemptsBlock}${verifiersBlock}${capsBlock}

本輪用戶輸入：
${input.userMessage}

請輸出本輪授權的 JSON。`;

  const t0 = Date.now();
  let raw = '';
  let parsed: Partial<PreKernelDecision> = {};
  try {
    const completion = await openai.chat.completions.create({
      model:           'gpt-4o-mini',
      messages:        [
        { role: 'system', content: PRE_KERNEL_SYSTEM },
        { role: 'user',   content: userPrompt },
      ],
      response_format: { type: 'json_object' },
      max_tokens:      400,
      temperature:     0,
    });
    await recordLLMCall({
      trace_id: input.meta?.traceId, tenant_id: input.meta?.tenantId,
      call_type: 'pre_kernel',
      tokens_input:  completion.usage?.prompt_tokens,
      tokens_output: completion.usage?.completion_tokens,
      latency_ms: Date.now() - t0,
    });
    raw = (completion.choices[0]?.message?.content ?? '').trim();
    parsed = JSON.parse(raw);
  } catch {
    return {
      verdict: 0,
      reason:  'pre_kernel_unavailable, defaulting to hold/clarify',
      scope:   ['clarification'],
      instruction: '無法判斷意圖，請禮貌追問用戶具體想了解什麼或需要什麼協助。',
      user_claims: [],
      repeat_count: repeatCount,
      extracted_identifiers: [],
      extracted_order_source: null,
      is_pure_affirmation: false,
      raw,
    };
  }

  const verdict: PreVerdict =
    parsed.verdict === 1  ?  1 :
    parsed.verdict === -1 ? -1 :
    parsed.verdict === -2 ? -2 :
    0;
  const scope = Array.isArray(parsed.scope) ? parsed.scope.map(String) : [];
  const reason = typeof parsed.reason === 'string' ? parsed.reason : '';
  const instruction = typeof parsed.instruction === 'string' && parsed.instruction.length > 0
    ? parsed.instruction
    : defaultInstruction(verdict);
  const user_claims = Array.isArray((parsed as { user_claims?: unknown }).user_claims)
    ? ((parsed as { user_claims: unknown[] }).user_claims).map(String).filter(s => s.length > 0)
    : [];

  const ids = Array.isArray((parsed as { extracted_identifiers?: unknown }).extracted_identifiers)
    ? ((parsed as { extracted_identifiers: unknown[] }).extracted_identifiers)
        .map((it) => it as ExtractedIdentifier)
        .filter(it => it && typeof it.type === 'string' && typeof it.value === 'string' && it.value.length > 0)
        .slice(0, 8)
    : [];

  const rawSource = (parsed as { extracted_order_source?: unknown }).extracted_order_source;
  const knownSources: OrderSource[] = ['mock','shopee','lazada','official_web','momo','pchome','tiktok_shop','other'];
  const orderSource: OrderSource = (typeof rawSource === 'string' && (knownSources as string[]).includes(rawSource))
    ? rawSource as OrderSource
    : null;

  const isAffirm = (parsed as { is_pure_affirmation?: unknown }).is_pure_affirmation === true;

  return {
    verdict, reason, scope, instruction,
    user_claims,
    repeat_count: repeatCount,
    extracted_identifiers: ids,
    extracted_order_source: orderSource,
    is_pure_affirmation: isAffirm,
    raw,
  };
}

function defaultInstruction(v: PreVerdict): string {
  if (v === 1)  return '在可用資料範圍內自然回答，禁止編造任何 KB 沒有的事實。';
  if (v === -1) return '簡短禮貌回應 1 句，引導用戶回到業務問題，不深入討論。';
  if (v === -2) return '告知用戶資料已轉給人工客服，30 字以內。';
  return '不要陳述任何事實。先追問必要資訊（如訂單編號、產品確認等）。';
}
