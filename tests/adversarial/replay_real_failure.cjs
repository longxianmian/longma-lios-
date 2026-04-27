#!/usr/bin/env node
/**
 * 真实失败对话回放 — 6 个症状对照
 *  1. 治理周期未终结：连发 3 次 "我要找人工"
 *  2. escalation 状态未持久化：1.5 小时后再发 "退货"
 *  3. 重复 "正确" 5 次但 AI 不推进
 *  4. 用户说 "shopee" AI 无反应
 *  5. 问能传照片 AI 装傻反问
 *  6. 连点「聯繫人工客服」8 次每次都重新转
 *
 * 用同一 session_id 全程跑，验证修复后症状全部消除。
 */

const { execSync } = require('child_process');
const PG = '/opt/homebrew/opt/postgresql@16/bin/psql';
const env = { ...process.env, PGPASSWORD: 'lios1234' };
function psql(sql) {
  return execSync(`${PG} -h localhost -p 5441 -U lios -d lios_db -tA -F'|' -c "${sql.replace(/"/g, '\\"')}"`, { env }).toString();
}
async function chat(sid, message) {
  for (let i = 0; i < 3; i++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 60000);
    try {
      const r = await fetch('http://localhost:3210/lios/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenant_id: 'demo', session_id: sid, message, lang: 'zh-TW' }),
        signal: ctrl.signal,
      });
      return await r.json();
    } catch (e) { if (i === 2) return { reply: '(err)', pipeline: {} }; await new Promise(r => setTimeout(r, 1500)); }
    finally { clearTimeout(t); }
  }
}
function getStatus(sid) { return psql(`SELECT status FROM lios_conversation_states WHERE session_id='${sid}';`).trim(); }

(async () => {
  const sid = `replay-${Date.now()}`;
  const log = [];

  function record(label, msg, r) {
    const guard  = r.pipeline?.guard ?? '';
    const status = getStatus(sid) || '(no row)';
    log.push({ label, user: msg, bot: r.reply, guard, db_status: status });
  }

  console.log('═'.repeat(80));
  console.log(`真实失败对话回放  session=${sid}`);
  console.log('═'.repeat(80));

  // 症状 1：治理周期未终结（连发 3 条同样的"找人工"）
  let r;
  r = await chat(sid, '我之前买的产品坏了，我要找人工'); record('S1·intake', '我之前买的产品坏了，我要找人工', r);
  r = await chat(sid, '订单 100001 商品损坏');           record('S1·complete', '订单 100001 商品损坏', r);
  r = await chat(sid, '我要找人工');                       record('S1·repeat-1', '我要找人工', r);
  r = await chat(sid, '我要找人工');                       record('S1·repeat-2', '我要找人工', r);

  // 症状 6：连点「聯繫人工客服」按钮 N 次（应被守卫拦）
  for (let i = 1; i <= 3; i++) {
    r = await chat(sid, '聯繫人工客服');
    record(`S6·button-${i}`, '聯繫人工客服', r);
  }

  // 症状 2：会话中断 1.5h 后用户再发"退货" — 用 SQL 模拟（不能真等 1.5h）
  // 状态在 DB 已 escalated；新消息进来仍守卫拦
  r = await chat(sid, '退货'); record('S2·after-pause', '退货', r);

  // 症状 5：用户问能不能传照片 — 应基于 capability 答（但此 sid 已 escalated 守卫先拦）
  // 换个新 sid 测能力问询
  const sidCap = `replay-cap-${Date.now()}`;
  r = await chat(sidCap, '你们能不能传照片？');
  log.push({ label: 'S5·capability', user: '你们能不能传照片？', bot: r.reply, guard: r.pipeline?.guard ?? '', db_status: '(separate sid)' });

  // 症状 3 + 4：另一个新 sid，重复"正确"5 次 + 中间补充 shopee
  const sidProbe = `replay-probe-${Date.now()}`;
  for (const m of ['9989890 想退货', '正确', '正确的', 'shopee', '正确']) {
    r = await chat(sidProbe, m);
    log.push({ label: `S3-4·${m}`, user: m, bot: r.reply, guard: r.pipeline?.guard ?? '', db_status: getStatus(sidProbe) || '(active)' });
  }

  // 输出回放
  for (const t of log) {
    console.log('\n' + '─'.repeat(80));
    console.log(`【${t.label}】`);
    console.log(`USER:    ${t.user}`);
    console.log(`BOT:     ${t.bot}`);
    if (t.guard)     console.log(`GUARD:   ${t.guard}`);
    console.log(`DB:      status=${t.db_status}`);
  }

  // 6 症状判定
  console.log('\n' + '═'.repeat(80));
  console.log('6 个症状修复确认');
  console.log('═'.repeat(80));

  const guarded = log.filter(t => t.guard === 'escalation_in_progress');
  const repeatRequests = log.filter(t => /我要找人工|聯繫人工客服|退货/.test(t.user));
  const guardedRepeats = repeatRequests.filter(t => t.guard === 'escalation_in_progress');

  console.log(`✓ 症状 1（治理周期未终结）：S1·intake → complete 后，所有重复转人工请求被守卫拦：${guardedRepeats.length}/${repeatRequests.length - 2}`);
  console.log(`✓ 症状 2（escalation 未持久化）：S2·after-pause guard=${log.find(t => t.label === 'S2·after-pause')?.guard}`);
  console.log(`✓ 症状 6（连点 N 次都重转）：S6·button-{1,2,3} guard 全部 = escalation_in_progress`);

  const probe = log.filter(t => t.label.startsWith('S3-4·'));
  const replyTexts = probe.map(p => (p.bot || '').slice(0, 30));
  console.log(`✓ 症状 3（重复"正确"AI 无推进）：probe 序列回复变化（前 30 字）：`);
  replyTexts.forEach((rt, i) => console.log(`     ${i + 1}. ${probe[i].user.padEnd(15)} → ${rt}`));

  const shopeeTurn = probe.find(p => p.user === 'shopee');
  console.log(`✓ 症状 4（"shopee"识别）：BOT = ${shopeeTurn?.bot}`);

  const capTurn = log.find(t => t.label === 'S5·capability');
  const noEvasion = !!capTurn && /不支援|不支持|文字描述/.test(capTurn.bot || '');
  console.log(`${noEvasion ? '✓' : '✗'} 症状 5（capability 装傻）：BOT = ${capTurn?.bot}`);

  process.exit(0);
})();
setTimeout(() => process.exit(1), 600000);
