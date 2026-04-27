#!/usr/bin/env node
/**
 * 对抗测试 runner
 *   node tests/adversarial/runner.cjs                 # 跑所有 case
 *   node tests/adversarial/runner.cjs S9 S10          # 只跑指定 case
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const CASES_DIR = path.join(__dirname, 'cases');
const PG = '/opt/homebrew/opt/postgresql@16/bin/psql';
const env = { ...process.env, PGPASSWORD: 'lios1234' };

function psql(sql) {
  return execSync(
    `${PG} -h localhost -p 5441 -U lios -d lios_db -tA -F'|' -c "${sql.replace(/"/g, '\\"')}"`,
    { env }
  ).toString();
}

async function chat(sid, message) {
  let lastErr;
  const headers = { 'Content-Type': 'application/json' };
  // T11 阶段 2：v2_1 是默认；这里仅在显式要求 legacy 时传 header
  // 用法：LIOS_RUNTIME_HEADER=legacy node tests/adversarial/runner.cjs
  if (process.env.LIOS_RUNTIME_HEADER) {
    headers['X-LIOS-Runtime'] = process.env.LIOS_RUNTIME_HEADER;
  }
  for (let i = 0; i < 3; i++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 90000);
    try {
      const r = await fetch('http://localhost:3210/lios/chat', {
        method: 'POST',
        headers,
        body: JSON.stringify({ tenant_id: 'demo', session_id: sid, message, lang: 'zh-TW' }),
        signal: ctrl.signal,
      });
      return await r.json();
    } catch (e) {
      lastErr = e;
      await new Promise(r => setTimeout(r, 1500));
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr;
}

function fetchPreKernel(traceId) {
  if (!traceId) return null;
  const sql = "SELECT l.payload->>'pre_verdict', l.payload->>'pre_reason', l.payload->'pre_scope', l.payload->>'pre_instruction', l.payload->>'attempts', l.payload->'attempt_log', l.payload->'user_claims_extracted', l.payload->'claims_verification_status', l.payload->>'channel', l.payload->'extracted_identifiers', l.payload->'verifications_performed', l.payload->>'second_pass_verdict', l.payload->'second_pass_scope', l.payload->>'extracted_order_source', l.payload->>'is_pure_affirmation' FROM lios_ledgers l JOIN lios_actions a ON a.id = l.entity_id JOIN lios_decisions d ON d.id = a.decision_id JOIN lios_intents i ON i.id = d.intent_id WHERE i.trace_id = '" + traceId + "'::uuid AND l.event_type IN ('action.created','action.idempotent_hit') AND l.payload->>'source'='unified_llm_v3_pre_kernel' LIMIT 1;";
  const out = psql(sql);
  if (!out.trim()) return null;
  const [v, reason, scope, instr, att, log, claims, vstatus, channel, ids, verifs, sp_v, sp_s, src, affirm] = out.trim().split('|');
  return {
    verdict: parseInt(v, 10),
    reason,
    scope: tryParse(scope) || [],
    instruction: instr,
    attempts: parseInt(att, 10) || 0,
    log: tryParse(log) || [],
    user_claims_extracted: tryParse(claims) || [],
    claims_verification_status: tryParse(vstatus) || {},
    channel,
    extracted_identifiers: tryParse(ids) || [],
    verifications_performed: tryParse(verifs) || [],
    second_pass_verdict: sp_v && sp_v !== '' ? parseInt(sp_v, 10) : null,
    second_pass_scope: tryParse(sp_s) || null,
    extracted_order_source: src || null,
    is_pure_affirmation: affirm === 'true',
  };
}

function fetchEscalationStatus(sid) {
  const out = psql("SELECT status FROM lios_conversation_states WHERE session_id='" + sid + "';");
  return out.trim() || null;
}
function tryParse(s) { try { return JSON.parse(s); } catch { return null; } }

function rxAnyMatch(text, patterns) {
  if (!Array.isArray(patterns) || patterns.length === 0) return true;
  return patterns.some(p => new RegExp(p).test(text || ''));
}
function rxNoneMatch(text, patterns) {
  if (!Array.isArray(patterns) || patterns.length === 0) return true;
  return !patterns.some(p => new RegExp(p).test(text || ''));
}
function singleQuestionPerTurn(text) {
  const t = (text || '').replace(/[?？！!。]\s*/g, m => m + '\n');
  const questionLines = t.split('\n').filter(line => /[?？]/.test(line));
  return questionLines.length <= 1;
}

function evalCase(caseDef, turnResults) {
  const checks = [];
  const expV = caseDef.expected_verdicts || [];

  for (let i = 0; i < turnResults.length; i++) {
    const t = turnResults[i];
    const reply = t.reply || '';
    const meta = t.meta || {};

    if (expV[i] !== undefined && expV[i] !== null) {
      checks.push([`T${i + 1} verdict=${expV[i]}`, meta.verdict === expV[i]]);
    }
    if (caseDef.max_len_per_turn !== undefined) {
      checks.push([`T${i + 1} len ≤ ${caseDef.max_len_per_turn}`, reply.length <= caseDef.max_len_per_turn]);
    }
    if (caseDef.expected_scope_min_size !== undefined && i === 0) {
      checks.push([`scope size ≥ ${caseDef.expected_scope_min_size}`, (meta.scope || []).length >= caseDef.expected_scope_min_size]);
    }
    if (caseDef.expected_scope_contains_any && i === 0) {
      const has = caseDef.expected_scope_contains_any.some(k => (meta.scope || []).includes(k));
      checks.push([`scope contains any of ${JSON.stringify(caseDef.expected_scope_contains_any)}`, has]);
    }
    if (caseDef.must_have_any) {
      checks.push([`T${i + 1} must_have_any`, rxAnyMatch(reply, caseDef.must_have_any)]);
    }
    if (caseDef.must_have_any_per_turn) {
      checks.push([`T${i + 1} must_have_any_per_turn`, rxAnyMatch(reply, caseDef.must_have_any_per_turn)]);
    }
    if (caseDef.must_not_match) {
      checks.push([`T${i + 1} no banned phrase`, rxNoneMatch(reply, caseDef.must_not_match)]);
    }
    if (Array.isArray(caseDef.extra_checks)) {
      if (caseDef.extra_checks.includes('single_question_per_turn')) {
        checks.push([`T${i + 1} single question`, singleQuestionPerTurn(reply)]);
      }
    }
  }

  if (Array.isArray(caseDef.extra_checks)) {
    if (caseDef.extra_checks.includes('len_non_increasing_after_2nd')) {
      const lens = turnResults.map(r => (r.reply || '').length);
      const ok = lens.length < 2 || lens.slice(1).every((l, i) => l <= lens[i] + 6); // 容忍 6 字波动
      checks.push([`lens non-increasing after 2nd  [${lens.join(',')}]`, ok]);
    }
    if (caseDef.extra_checks.includes('no_identical_prefix_4chars_3rounds')) {
      const replies = turnResults.map(r => (r.reply || '').slice(0, 4));
      const allSame = replies.length >= 3 && replies.every(p => p === replies[0]);
      checks.push([`no identical 4-char prefix across all rounds`, !allSame]);
    }
    if (caseDef.extra_checks.includes('no_full_x9_intro_after_2nd')) {
      const introMarks = /(AMOLED|150\+?\s*種|航空級|藍牙|心率.*血氧|月光銀)/;
      const ok = turnResults.slice(1).every(r => !introMarks.test(r.reply || ''));
      checks.push([`no full X9 intro after 2nd`, ok]);
    }
    if (caseDef.extra_checks.includes('last_turn_is_escalate')) {
      const last = turnResults[turnResults.length - 1];
      checks.push([`last turn verdict=-2 (escalate)`, last?.meta?.verdict === -2]);
    }
    // ── v8 Ledger 检查 ──
    for (const key of caseDef.extra_checks) {
      const m1 = key.match(/^ledger_extracted_identifiers_has_order_(.+)$/);
      if (m1) {
        const exp = m1[1];
        const meta = turnResults[0]?.meta;
        const ids = meta?.extracted_identifiers ?? [];
        const ok = Array.isArray(ids) && ids.some(i => i?.type === 'order_id' && String(i.value) === exp);
        checks.push([`ledger.extracted_identifiers contains order_id=${exp}`, ok]);
      }
      const m2 = key.match(/^ledger_verifications_classification_(.+)$/);
      if (m2) {
        const exp = m2[1];
        const meta = turnResults[0]?.meta;
        const vfs = meta?.verifications_performed ?? [];
        const ok = Array.isArray(vfs) && vfs.some(v => v?.result === exp);
        checks.push([`ledger.verifications_performed.result=${exp}`, ok]);
      }
      const m3 = key.match(/^ledger_second_pass_verdict_is_(-?\d)$/);
      if (m3) {
        const exp = parseInt(m3[1], 10);
        const meta = turnResults[0]?.meta;
        checks.push([`ledger.second_pass_verdict=${exp}`, meta?.second_pass_verdict === exp]);
      }
    }
    if (caseDef.extra_checks.includes('handoff_context_packaged')) {
      // 通过 lios_agent_sessions 看 handoff_context 是否被打包
      const sid = (turnResults[0] && turnResults[0].sid_used) ||
                  (caseDef.__current_sid__ || null);
      checks.push([`handoff_context packaged in DB`, !!sid]); // placeholder, real check in runCase wrapper
    }
  }

  return checks;
}

function fetchHandoffContext(sid) {
  const out = psql(`SELECT handoff_context FROM lios_agent_sessions WHERE session_id = '${sid}' AND handoff_context IS NOT NULL ORDER BY created_at DESC LIMIT 1;`);
  if (!out.trim()) return null;
  return tryParse(out.trim());
}

async function runCase(caseDef) {
  const sid = `${caseDef.id}-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;

  // Preconditions（如 mark_escalated）
  if (Array.isArray(caseDef.preconditions)) {
    for (const pre of caseDef.preconditions) {
      if (pre === 'mark_escalated') {
        psql(`INSERT INTO lios_conversation_states (session_id, tenant_id, status, escalated_at, escalation_reason) VALUES ('${sid}','demo','escalated', now(),'precondition') ON CONFLICT (session_id) DO UPDATE SET status='escalated', escalated_at=now();`);
      }
    }
  }

  const turnResults = [];
  for (let i = 0; i < caseDef.turns.length; i++) {
    let r;
    try { r = await chat(sid, caseDef.turns[i]); }
    catch (e) { r = { reply: `(err: ${e.message})`, trace_id: null }; }
    const meta = fetchPreKernel(r.trace_id);
    const guard = r.pipeline?.guard;
    turnResults.push({ user: caseDef.turns[i], reply: r.reply || '', meta, guard, raw_response: r });
    await new Promise(rs => setTimeout(rs, 350));
  }
  let checks = evalCase(caseDef, turnResults);

  // 真实校验 handoff_context_packaged
  if (Array.isArray(caseDef.extra_checks) && caseDef.extra_checks.includes('handoff_context_packaged')) {
    const ctx = fetchHandoffContext(sid);
    checks = checks.filter(c => !c[0].startsWith('handoff_context packaged'));
    checks.push([`handoff_context.user_original_complaint != ''`, !!(ctx && ctx.user_original_complaint)]);
    checks.push([`handoff_context.verdict_trajectory.length >= 2`, !!(ctx && Array.isArray(ctx.verdict_trajectory) && ctx.verdict_trajectory.length >= 2)]);
    checks.push([`handoff_context.collected_verification non-empty`, !!(ctx && ctx.collected_verification && Object.keys(ctx.collected_verification).length > 0)]);
    // 把 ctx 暴露给 fmtCase 显示
    turnResults.__handoff_ctx__ = ctx;
  }

  const passed = checks.every(c => c[1]);
  return { caseDef, sid, turnResults, checks, passed };
}

function fmtCase(result) {
  const { caseDef, turnResults, checks, passed } = result;
  const out = [];
  out.push('');
  out.push('='.repeat(80));
  out.push(`【${caseDef.id}】 ${caseDef.label}    ${passed ? '✅ PASS' : '❌ FAIL'}`);
  out.push('='.repeat(80));
  for (let i = 0; i < turnResults.length; i++) {
    const t = turnResults[i];
    out.push(`— T${i + 1} —`);
    out.push(`USER: ${t.user}`);
    out.push(`BOT:  ${t.reply}`);
    if (t.meta) {
      out.push(`pre:  v=${t.meta.verdict}  scope=${JSON.stringify(t.meta.scope)}  attempts=${t.meta.attempts}`);
      if (t.meta.user_claims_extracted && t.meta.user_claims_extracted.length > 0) {
        out.push(`claims: ${JSON.stringify(t.meta.user_claims_extracted)}`);
      }
      if (t.meta.claims_verification_status && Object.keys(t.meta.claims_verification_status).length > 0) {
        out.push(`vstatus: ${JSON.stringify(t.meta.claims_verification_status)}`);
      }
      const failedAttempts = (Array.isArray(t.meta.log) ? t.meta.log : []).filter(a => !a.passed);
      if (failedAttempts.length > 0) {
        out.push(`审计拦截 ${failedAttempts.length} 次:`);
        failedAttempts.forEach((a, idx) => {
          const violations = (a.violations || []).map(v => `${v.type}:${(v.detail || '').slice(0, 30)}`).join('; ');
          out.push(`  attempt ${a.attempt}: ${violations}`);
        });
      }
    }
  }
  out.push('checks:');
  for (const [name, ok] of checks) {
    out.push(`  ${ok ? '✓' : '✗'}  ${name}`);
  }
  if (turnResults.__handoff_ctx__) {
    const c = turnResults.__handoff_ctx__;
    out.push('handoff_context (摘要):');
    out.push(`  user_original_complaint: ${(c.user_original_complaint || '').slice(0, 80)}`);
    out.push(`  collected_verification: ${JSON.stringify(c.collected_verification || {})}`);
    out.push(`  verdict_trajectory.length: ${(c.verdict_trajectory || []).length}`);
    out.push(`  blocked_claims.length: ${(c.blocked_claims || []).length}`);
    out.push(`  ai_attempts_total: ${c.ai_attempts_total ?? '?'}`);
  }
  return out.join('\n');
}

(async () => {
  const filter = process.argv.slice(2);
  const allFiles = fs.readdirSync(CASES_DIR)
    .filter(f => f.endsWith('.json'))
    .sort();
  const cases = allFiles
    .map(f => JSON.parse(fs.readFileSync(path.join(CASES_DIR, f), 'utf8')))
    .filter(c => filter.length === 0 || filter.includes(c.id));

  const results = [];
  for (const c of cases) {
    const r = await runCase(c);
    results.push(r);
    console.log(fmtCase(r));
  }

  console.log('\n' + '='.repeat(80));
  console.log('汇总');
  console.log('='.repeat(80));
  const pass = results.filter(r => r.passed).length;
  console.log(`${pass}/${results.length} pass`);
  console.log('');
  console.log('| Case | 标签 | verdict | scope | 结果 |');
  console.log('|------|------|---------|-------|------|');
  for (const r of results) {
    const meta0 = r.turnResults[0]?.meta || {};
    console.log(`| ${r.caseDef.id} | ${r.caseDef.label} | ${meta0.verdict ?? '?'} | ${JSON.stringify(meta0.scope || []).slice(0, 50)} | ${r.passed ? '✅' : '❌'} |`);
  }

  process.exit(results.every(r => r.passed) ? 0 : 1);
})();
