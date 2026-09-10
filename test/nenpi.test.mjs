import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  analyzeSession, mergeQuality, sessionRate, summaryJson,
  bandOf, bandLabel, BANDS, CORRECTION_WORDS, injectedText,
  t, envInt, readStateFrom,
  lastContext, nudgeDecide, nudgeText, rateFor, tailLines,
  bundleVerdict, bundleDecide,
  fuel, verdict, VROWS,
  sparMode, muted,
  foldResponses,
  classifyError, tallyErrors, emptyErrors, errorsJson, ENV_ERROR_WORDS,
} from '../src/nenpi.mjs';

// Most assertions below check the Japanese wording, so pin the output language.
process.env.NENPI_LANG = 'ja';

const asst = (id, ctx, content, extra = {}) => ({
  type: 'assistant', requestId: 'req_' + id, timestamp: '2026-09-01T00:00:00.000Z',
  message: {
    id, content,
    usage: {
      input_tokens: 10, output_tokens: 20,
      cache_read_input_tokens: ctx, cache_creation_input_tokens: 0,
    },
  },
  ...extra,
});
const useRead = (p) => [{ type: 'tool_use', id: 'tu', name: 'Read', input: { file_path: p } }];
const useEdit = (p) => [{ type: 'tool_use', id: 'tu', name: 'Edit', input: { file_path: p } }];
const result = (text, isErr) => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', content: text, ...(isErr ? { is_error: true } : {}) }] },
});
const say = (t) => ({ type: 'user', message: { content: t } });

test('同じ message.id を持つ分割行を二重に数えない', () => {
  const a = analyzeSession([
    asst('m1', 1000, [{ type: 'thinking', thinking: 'x' }]),
    asst('m1', 1000, [{ type: 'text', text: 'y' }]),
    asst('m2', 2000, [{ type: 'text', text: 'z' }]),
  ]);
  assert.equal(a.turns, 2);
  assert.deepEqual(a.ctxByTurn, [1010, 2010]);
});

test('再読み・手戻り・ツール失敗・訂正を数える', () => {
  const a = analyzeSession([
    asst('m1', 1000, useRead('/x/a.txt')), result('ok'),
    asst('m2', 1000, useRead('/x/a.txt')), result('ok'),
    asst('m3', 1000, useEdit('/x/b.txt')), result('ok'),
    asst('m4', 1000, useEdit('/x/b.txt')), result('boom', true),
    say('違うよ、そこじゃない'),
    say('つづけて'),
  ]);
  assert.equal(a.reads, 2);
  assert.equal(a.reread, 1);
  assert.equal(a.rereadAcrossCompact, 0);
  assert.equal(a.edits, 2);
  assert.equal(a.rework, 1);
  assert.equal(a.toolResults, 4);
  assert.equal(a.toolErrors, 1);
  assert.equal(a.userPrompts, 2);
  assert.equal(a.corrections, 1);
});

test('編集の間隔が6ターン空けば手戻りに数えない', () => {
  const recs = [asst('e0', 1000, useEdit('/x/b.txt'))];
  for (let i = 1; i <= 6; i++) recs.push(asst('n' + i, 1000, [{ type: 'text', text: '.' }]));
  recs.push(asst('e1', 1000, useEdit('/x/b.txt')));
  assert.equal(analyzeSession(recs).rework, 0);
});

test('空振りRead — 後で名前が出てくれば空振りにしない', () => {
  const wasted = analyzeSession([
    asst('m1', 1000, useRead('/x/a.txt')), result('ok'),
    asst('m2', 1000, [{ type: 'text', text: '別の話をします' }]),
  ]);
  assert.equal(wasted.wasted, 1);

  const used = analyzeSession([
    asst('m1', 1000, useRead('/x/a.txt')), result('ok'),
    asst('m2', 1000, [{ type: 'text', text: 'a.txt を直します' }]),
  ]);
  assert.equal(used.wasted, 0);
});

test('Read しただけでは「使った」ことにしない（再読みは空振りを消さない）', () => {
  const a = analyzeSession([
    asst('m1', 1000, useRead('/x/a.txt')), result('ok'),
    asst('m2', 1000, useRead('/x/a.txt')), result('ok'),
  ]);
  assert.equal(a.wasted, 2);
});

test('compact をまたいだ再読みを分けて数える', () => {
  const a = analyzeSession([
    asst('m1', 1000, useRead('/x/a.txt')), result('ok'),
    { type: 'system', compactMetadata: { trigger: 'auto', preTokens: 900, postTokens: 100, cumulativeDroppedTokens: 800 } },
    asst('m2', 1000, useRead('/x/a.txt')), result('ok'),
  ]);
  assert.equal(a.reread, 1);
  assert.equal(a.rereadAcrossCompact, 1);
  assert.equal(a.compacts.length, 1);
  assert.equal(a.compacts[0].dropped, 800);
});

test('中断と拒否を数える', () => {
  const a = analyzeSession([
    asst('m1', 1000, [{ type: 'text', text: 'x' }]),
    { type: 'user', toolDenialKind: 'automode-blocked', message: { content: [] } },
    { type: 'user', interruptedMessageId: 'm1', message: { content: [] } },
  ]);
  assert.equal(a.denials, 1);
  assert.equal(a.interrupts, 1);
});

test('isMeta / isCompactSummary はユーザー発言に数えない', () => {
  const a = analyzeSession([
    asst('m1', 1000, [{ type: 'text', text: 'x' }]),
    { type: 'user', isMeta: true, message: { content: '間違っています' } },
    { type: 'user', isCompactSummary: true, message: { content: 'やり直し' } },
  ]);
  assert.equal(a.userPrompts, 0);
  assert.equal(a.corrections, 0);
});

test('turn_duration とフックと注入テキストを拾う', () => {
  const a = analyzeSession([
    asst('m1', 1000, useRead('/x/a.txt')),
    result('ok'),
    {
      type: 'system', subtype: 'stop_hook_summary', hookCount: 2, hookErrors: ['e'],
      hookInfos: [
        { command: 'node "C:/d/airframe.mjs" hook land', durationMs: 200 },
        { command: 'bash "${R}/hooks/sg.sh" "${R}/hooks/security_reminder_hook.py"' },
      ],
    },
    { type: 'system', subtype: 'turn_duration', durationMs: 4200 },
  ]);
  assert.equal(a.humanTurns, 1);
  assert.deepEqual(a.durations.map((d) => d.ms), [4200]);
  assert.equal(a.hookErrors, 1);
  assert.equal(a.hooks['airframe hook land'].ms, 200);
  assert.equal(a.hooks.security_reminder_hook.timed, 0);
});

test('cost-state はいちばん進んだ1件を採る（行ごとに足さない）', () => {
  const mk = (usd, wall) => ({
    type: 'cost-state', totalCostUSD: usd, totalDuration: wall,
    totalAPIDuration: 100, totalToolDuration: 50, totalLinesAdded: 3, totalLinesRemoved: 1,
    modelUsage: { 'claude-opus-5[1m]': { inputTokens: 100, outputTokens: 100, cacheReadInputTokens: 10000, cacheCreationInputTokens: 0, costUSD: usd } },
  });
  const a = analyzeSession([asst('m1', 1000, [{ type: 'text', text: 'x' }]), mk(1, 100), mk(3, 300), mk(2, 200)]);
  assert.equal(a.cost.usd, 3);
  const r = sessionRate(a);
  assert.equal(r.eq, 100 * 1 + 0 * 1.25 + 10000 * 0.1 + 100 * 5);
  assert.equal(r.usd, 3);
  assert.ok(Math.abs(r.rate - 3 / 1600) < 1e-12);
});

test('文脈長帯の割り当て', () => {
  assert.equal(bandOf(0), 0);
  assert.equal(bandOf(99_999), 0);
  assert.equal(bandOf(100_000), 1);
  assert.equal(bandOf(350_000), 2);
  assert.equal(bandOf(5_000_000), BANDS.length - 1);
  assert.equal(bandLabel(1), '100K-200K');
});

test('相関表は「そのターンに入った時点の文脈長」で振り分ける', () => {
  const a = analyzeSession([
    asst('m1', 50_000, useRead('/x/a.txt')), result('ok', true),
    asst('m2', 450_000, useRead('/x/a.txt')), result('ok'),
  ]);
  // 1件目の tool_result はターン1の文脈(50K)の帯へ、2件目はターン2(450K)の帯へ。
  assert.equal(a.byBand[0].tr, 1);
  assert.equal(a.byBand[0].err, 1);
  assert.equal(a.byBand[3].tr, 1);
  assert.equal(a.byBand[3].err, 0);
  assert.equal(a.byBand[3].reread, 1);
});

test('mergeQuality はセッションを足し合わせる', () => {
  const one = () => analyzeSession([
    asst('m1', 1000, useRead('/x/a.txt')), result('ok', true),
    say('やり直して'),
    {
      type: 'cost-state', totalCostUSD: 2, totalDuration: 10, totalAPIDuration: 4, totalToolDuration: 3,
      totalLinesAdded: 5, totalLinesRemoved: 2,
      modelUsage: { m: { inputTokens: 10, outputTokens: 10, cacheReadInputTokens: 100, cacheCreationInputTokens: 0, costUSD: 2 } },
    },
  ]);
  const m = mergeQuality([one(), one()]);
  assert.equal(m.sessions, 2);
  assert.equal(m.turns, 2);
  assert.equal(m.reads, 2);
  assert.equal(m.toolErrors, 2);
  assert.equal(m.corrections, 2);
  assert.equal(m.usd, 4);
  assert.equal(m.add, 10);
  assert.equal(m.del, 4);
  assert.equal(m.costSessions, 2);
  assert.equal(m.rates.length, 2);
  assert.equal(m.days['2026-09-01'].turns, 2);
});

test('ターンの無いセッションは集計から落とす', () => {
  const m = mergeQuality([analyzeSession([say('こんにちは')])]);
  assert.equal(m.sessions, 0);
  assert.equal(m.turns, 0);
});

test('summaryJson は割り算でゼロ除算しない', () => {
  const j = summaryJson(mergeQuality([]), 30);
  assert.equal(j.turns, 0);
  for (const v of Object.values(j.quality)) assert.ok(Number.isFinite(v));
  for (const v of Object.values(j.speed)) assert.ok(Number.isFinite(v));
});

test('訂正語の一覧は空でない（出力に貼って監査するもの）', () => {
  assert.ok(CORRECTION_WORDS.length >= 10);
  assert.ok(CORRECTION_WORDS.includes('違う'));
});

test('英語の訂正も数える（大文字小文字・アポストロフィの種類を問わない）', () => {
  const a = analyzeSession([
    asst('m1', 1000, useEdit('/x/b.txt')), result('ok'),
    say('No, that’s not what I asked for'),
    say('go on'),
  ]);
  assert.equal(a.userPrompts, 2);
  assert.equal(a.corrections, 1);
});

test('状態は新しい置き場を先に見て、無ければ旧 tools/ に落ちる', () => {
  const now = fs.mkdtempSync(path.join(os.tmpdir(), 'nenpi-now-'));
  const old = fs.mkdtempSync(path.join(os.tmpdir(), 'nenpi-old-'));
  fs.writeFileSync(path.join(old, 'nenpi-baseline.json'), JSON.stringify({ where: 'old' }));

  // 移行直後：新しい方はまだ空なので、旧い基準がそのまま読める
  assert.deepEqual(readStateFrom([now, old], 'nenpi-baseline.json'), { where: 'old' });

  // 一度でも新しい方に書かれたら、そちらが勝つ
  fs.writeFileSync(path.join(now, 'nenpi-baseline.json'), JSON.stringify({ where: 'new' }));
  assert.deepEqual(readStateFrom([now, old], 'nenpi-baseline.json'), { where: 'new' });

  // どこにも無い、あるいは壊れている場合は null。例外は投げない
  assert.equal(readStateFrom([now, old], 'nenpi-nope.json'), null);
  fs.writeFileSync(path.join(now, 'broken.json'), '{');
  assert.equal(readStateFrom([now, old], 'broken.json'), null);
});

test('出力言語は NENPI_LANG → ロケール変数 → OS ロケール → 英語の順で決まる', () => {
  const saved = { ...process.env };
  try {
    process.env.NENPI_LANG = 'en';
    assert.equal(t('yes', 'はい'), 'yes');
    process.env.NENPI_LANG = 'ja';
    assert.equal(t('yes', 'はい'), 'はい');
    delete process.env.NENPI_LANG;
    process.env.LANG = 'ja_JP.UTF-8';
    delete process.env.LC_ALL;
    delete process.env.LC_MESSAGES;
    assert.equal(t('yes', 'はい'), 'はい');
    process.env.LANG = 'en_US.UTF-8';
    assert.equal(t('yes', 'はい'), 'yes');
    // No locale variable at all: fall back to the OS locale, which is where Windows
    // lives — it sets none of these. English only if that is not Japanese either.
    delete process.env.LANG;
    const os = Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase();
    assert.equal(t('yes', 'はい'), os.startsWith('ja') ? 'はい' : 'yes');
  } finally {
    for (const k of ['NENPI_LANG', 'LANG', 'LC_ALL', 'LC_MESSAGES']) {
      if (k in saved) process.env[k] = saved[k]; else delete process.env[k];
    }
    process.env.NENPI_LANG = 'ja';
  }
});


const hookAtt = (a) => ({ type: 'attachment', attachment: a });

test('injectedText は additionalContext を取り出し、素の出力はそのまま返す', () => {
  assert.equal(injectedText(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'ここが注入分' },
  })), 'ここが注入分');
  assert.equal(injectedText(JSON.stringify({ additionalContext: 'こちらも' })), 'こちらも');
  assert.equal(injectedText(JSON.stringify({ hookSpecificOutput: { permissionDecision: 'allow' } })), '');
  assert.equal(injectedText('SessionStart の素の出力'), 'SessionStart の素の出力');
  assert.equal(injectedText(''), '');
  assert.equal(injectedText(undefined), '');
});

test('attachment の hook_* から回数・時間・注入トークン・打切・失敗を数える', () => {
  const a = analyzeSession([
    asst('m1', 1000, [{ type: 'text', text: 'x' }]),
    hookAtt({
      type: 'hook_success', hookEvent: 'PreToolUse', durationMs: 120,
      command: 'node "C:/x/redline.mjs" hook pre',
      stdout: JSON.stringify({ hookSpecificOutput: { additionalContext: 'あ'.repeat(350) } }),
    }),
    hookAtt({
      type: 'hook_success', hookEvent: 'Stop', durationMs: 80,
      command: 'node "C:/x/redline.mjs" hook pre',
      stdout: JSON.stringify({ hookSpecificOutput: { permissionDecision: 'allow' } }),
    }),
    hookAtt({
      type: 'hook_cancelled', hookEvent: 'UserPromptSubmit', durationMs: 10137, timedOut: true,
      command: 'powershell.exe -File "C:/x/auto-load-workflow.ps1"',
    }),
    hookAtt({
      type: 'hook_non_blocking_error', hookEvent: 'PostToolUse', durationMs: 5,
      command: 'node "C:/x/habit.mjs" hook post', stderr: 'boom',
    }),
    hookAtt({ type: 'hook_additional_context', hookEvent: 'PreToolUse', content: ['二重に数えないこと'] }),
  ]);

  const r = a.att['redline hook pre'];
  assert.equal(r.n, 2);
  assert.equal(r.ms, 200);
  assert.equal(r.timed, 2);
  assert.equal(r.injN, 1);            // 注入があったのは1回だけ
  assert.equal(r.tok, Math.round(350 / 3.5));
  assert.equal(a.att['auto-load-workflow'].cancel, 1);
  assert.equal(a.att['habit hook post'].err, 1);
  assert.equal(a.hookErrors, 1);
  assert.equal(a.hookCtxCount, 1);    // hook_additional_context は重複なので数えない
  assert.equal(a.hookCtxTok, Math.round(350 / 3.5));
  assert.deepEqual(a.attEvents, { PreToolUse: 1, Stop: 1, UserPromptSubmit: 1, PostToolUse: 1 });
});

test('mergeQuality はフックの実績も足し合わせる', () => {
  const one = () => analyzeSession([
    asst('m1', 1000, [{ type: 'text', text: 'x' }]),
    hookAtt({
      type: 'hook_success', hookEvent: 'Stop', durationMs: 50,
      command: 'node "C:/x/groundtruth-gate.mjs"',
      stdout: JSON.stringify({ additionalContext: 'abcdefg' }),
    }),
  ]);
  const m = mergeQuality([one(), one()]);
  assert.equal(m.att['groundtruth-gate'].n, 2);
  assert.equal(m.att['groundtruth-gate'].ms, 100);
  assert.equal(m.att['groundtruth-gate'].injN, 2);
  assert.equal(m.attEvents.Stop, 2);
  assert.equal(m.hookCtxCount, 2);
});

/* ── セッションを切る判断材料（hook prompt）─────────────────────────── */

const usageLine = (ctx, model = 'claude-opus-5') => JSON.stringify({
  type: 'assistant',
  message: { id: 'm', model, usage: { input_tokens: 5, cache_read_input_tokens: ctx, cache_creation_input_tokens: 0 } },
});

test('lastContext は末尾に一番近い assistant の usage を文脈の大きさとして返す', () => {
  const c = lastContext([usageLine(100000), '{"type":"user"}', usageLine(430000), 'こわれた行 {']);
  assert.equal(c.ctx, 430005);
  assert.equal(c.model, 'claude-opus-5');
  assert.equal(lastContext([]), null);
  assert.equal(lastContext(['{"type":"user"}', 'not json']), null);
});

test('tailLines は末尾だけを読み、途中で切れた先頭行を捨てる', () => {
  const f = path.join(os.tmpdir(), 'nenpi-tail-' + process.pid + '.jsonl');
  const NL = String.fromCharCode(10);
  fs.writeFileSync(f, 'あ'.repeat(2000) + NL + usageLine(410000) + NL);
  try {
    const lines = tailLines(f, 512);
    assert.ok(lines.length >= 1);
    assert.equal(lastContext(lines).ctx, 410005);   // 末尾は読めている
    assert.ok(!lines.some((l) => l.startsWith('あ'))); // 切れた先頭行は捨てている
  } finally { fs.unlinkSync(f); }
  assert.deepEqual(tailLines(path.join(os.tmpdir(), 'nenpi-nope-' + process.pid)), []);
});

test('rateFor はモデル名から cache_read の単価を選ぶ（不明なら opus 扱い）', () => {
  assert.equal(rateFor('claude-opus-5'), 1.5);
  assert.equal(rateFor('claude-sonnet-5'), 0.3);
  assert.equal(rateFor('claude-haiku-4-5-20251001'), 0.08);
  assert.equal(rateFor(undefined), 1.5);
});

test('nudgeText は文脈の大きさと1ターンあたりの読み直し代を出す', () => {
  const t = nudgeText(420000, 'claude-opus-5', 87);
  assert.match(t, /^\[nenpi\] /);
  assert.match(t, /420K tok/);
  assert.match(t, /発言 87 回目/);
  assert.match(t, /\$0\.63/);        // 420000 / 1e6 * 1.5
  assert.match(t, /\/clear/);
});

test('しきい値未満では黙る。超えたら1回だけ出し、次は40発言空ける', () => {
  const st = {};
  const small = { ctx: 120000, model: 'claude-opus-5' };
  const big = { ctx: 420000, model: 'claude-opus-5' };

  assert.equal(nudgeDecide(st, 's1', small), '');        // 文脈が小さいうちは何も言わない
  assert.equal(st.s1.prompts, 1);

  const first = nudgeDecide(st, 's1', big);              // 超えたら即出す（再開しても出る）
  assert.match(first, /420K tok/);
  assert.equal(st.s1.lastNudge, 2);

  for (let i = 0; i < 39; i++) assert.equal(nudgeDecide(st, 's1', big), ''); // 間は黙る
  assert.equal(st.s1.prompts, 41);
  assert.match(nudgeDecide(st, 's1', big), /420K tok/);  // 40発言空けたらまた出す
  assert.equal(st.s1.prompts, 42);

  assert.equal(nudgeDecide(st, 's2', null), '');         // usage が読めなければ黙る
});

test('文脈が細くても、発言が積もれば一度は値段を出す', () => {
  const st = {};
  const thin = { ctx: 120000, model: 'claude-opus-5' };
  for (let i = 0; i < 59; i++) assert.equal(nudgeDecide(st, 'long', thin), ''); // 59発言目までは黙る
  assert.match(nudgeDecide(st, 'long', thin), /120K tok/);                      // 60発言目で出す
  assert.equal(st.long.prompts, 60);

  const st2 = {};                                    // 本当に小さい文脈なら何発言続いても言わない
  const tiny = { ctx: 50000, model: 'claude-opus-5' };
  for (let i = 0; i < 80; i++) assert.equal(nudgeDecide(st2, 'tiny', tiny), '');
});

test('7日を過ぎたセッションの記録は台帳から落ちる', () => {
  const now = Date.now();
  const st = { old: { prompts: 900, lastNudge: 900, at: now - 8 * 86400e3 }, live: { prompts: 3, lastNudge: 0, at: now } };
  nudgeDecide(st, 'live', null, now);
  assert.equal(st.old, undefined);
  assert.equal(st.live.prompts, 4);
});

/* ── 判定（燃費・知能・速度）─────────────────── */

const mk = (o = {}) => ({
  days_: o.days_ || { d1: { cacheRead: 1000, turns: 10 } },
  quality: Object.assign(
    { toolErrorRate: 5, reworkRate: 5, correctionRate: 5, wastedReadRate: 50, turnsPerPrompt: 15 },
    o.quality),
  speed: Object.assign({ turnMedianMs: 200000 }, o.speed),
});

test('fuel は日ごとの cache_read を全ターンで割る', () => {
  const f = fuel(mk({ days_: { a: { cacheRead: 300, turns: 2 }, b: { cacheRead: 700, turns: 3 } } }));
  assert.equal(f.read, 1000);
  assert.equal(f.turns, 5);
  assert.equal(f.perTurn, 200);
  assert.equal(fuel({}).perTurn, 0);        // days_ が無くても落ちない
  assert.equal(fuel({ days_: {} }).turns, 0);
});

test('同じ数字どうしなら全部「変化なし」', () => {
  const v = verdict(mk(), mk());
  assert.equal(v.rows.length, VROWS.length);
  assert.ok(v.rows.every((r) => r.dir === 'flat'));
  assert.match(v.say, /まだ差が出ていない/);
});

test('燃費だけ下がれば狙いどおり', () => {
  const base = mk();
  const now = mk({ days_: { a: { cacheRead: 600, turns: 10 } } });   // 100 → 60 tok/turn
  const v = verdict(base, now);
  assert.equal(v.rows[0].dir, 'better');
  assert.equal(Math.round(v.rows[0].d), -40);
  assert.match(v.say, /狙いどおり/);
});

test('賢さが落ちていたら、燃費が下がっていても警告する', () => {
  const base = mk();
  const now = mk({
    days_: { a: { cacheRead: 500, turns: 10 } },       // 燃費は半分
    quality: { toolErrorRate: 9, reworkRate: 5, correctionRate: 5, wastedReadRate: 50, turnsPerPrompt: 15 },
  });
  const v = verdict(base, now);
  assert.equal(v.rows[0].dir, 'better');
  assert.match(v.say, /^⚠/);
  assert.match(v.say, /ツール失敗率/);
});

test('±5% 未満の差は揺れとして無視する', () => {
  const base = mk();
  const now = mk({ quality: { toolErrorRate: 5.2 } });   // +4%
  assert.equal(verdict(base, now).rows[1].dir, 'flat');
  const big = mk({ quality: { toolErrorRate: 5.5 } });   // +10%
  assert.equal(verdict(base, big).rows[1].dir, 'worse');
});

test('基準側が 0 の指標は「基準なし」になる', () => {
  const base = mk({ quality: { correctionRate: 0 } });
  assert.equal(verdict(base, mk()).rows[3].dir, 'nobase');
});

/* ── 機体（airframe）との接続 ──────────────────────── */

const sortieAt = (mode) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'nenpi-spar-'));
  fs.mkdirSync(path.join(d, '.spar'));
  if (mode) {
    fs.writeFileSync(path.join(d, '.spar', 'sortie.json'), JSON.stringify({ mode, id: 'x' }));
  }
  return d;
};

test('cruise なら黙り、strike なら口を出す', () => {
  assert.equal(sparMode(sortieAt('cruise')), 'cruise');
  assert.equal(muted(sortieAt('cruise')), true);
  assert.equal(sparMode(sortieAt('strike')), 'strike');
  assert.equal(muted(sortieAt('strike')), false);
});

test('機体が見つからなければ strike 扱い（nenpi 単体で動く）', () => {
  assert.equal(sparMode(sortieAt(null)), 'strike');   // .spar はあるが sortie.json が無い
  assert.equal(sparMode(fs.mkdtempSync(path.join(os.tmpdir(), 'nenpi-nospar-'))), 'strike');
  assert.equal(sparMode(undefined), 'strike');       // イベントに cwd が無い
});

test('壊れた sortie.json でも黙らずに strike 扱いにする', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'nenpi-bad-'));
  fs.mkdirSync(path.join(d, '.spar'));
  fs.writeFileSync(path.join(d, '.spar', 'sortie.json'), '{ not json');
  assert.equal(sparMode(d), 'strike');
});

/* ── 口出しの効き目（effect）────────────────────── */

const line = (req, t, blocks) => JSON.stringify({
  type: 'assistant', requestId: req, timestamp: t,
  message: { id: 'msg_' + req, content: blocks },
});
const use = { type: 'tool_use', name: 'Bash', id: 'x' };
const think = { type: 'thinking', thinking: '...' };
const hookLine = (t, kind, out) => JSON.stringify({
  type: 'attachment', timestamp: t,
  attachment: { type: 'hook_success', command: 'node "C:/x/nenpi.mjs" hook ' + kind, stdout: out },
});

test('割れた応答を requestId で足し上げる（並列が 0.0% になるバグ）', () => {
  // 1回の応答が3行に割れ、tool_use が2本入っている
  const { turns } = foldResponses([
    line('r1', '2026-09-01T00:00:00Z', [think]),
    line('r1', '2026-09-01T00:00:01Z', [use]),
    line('r1', '2026-09-01T00:00:02Z', [use]),
    line('r2', '2026-09-01T00:01:00Z', [use]),
  ]);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].tools, 2);   // 行で数えると 1 になる
  assert.equal(turns[1].tools, 1);
});

test('ターンは時刻順に並ぶ', () => {
  const { turns } = foldResponses([
    line('r2', '2026-09-01T00:05:00Z', [use]),
    line('r1', '2026-09-01T00:00:00Z', [use]),
  ]);
  assert.ok(turns[0].t < turns[1].t);
});

test('nenpi のフックだけを拾い、種類を見分ける', () => {
  const { fires } = foldResponses([
    hookLine('2026-09-01T00:00:00Z', 'post', '[nenpi] 束ねろ'),
    hookLine('2026-09-01T00:00:01Z', 'pre', 'updatedInput'),
    hookLine('2026-09-01T00:00:02Z', 'prompt', '[nenpi] 文脈'),
    JSON.stringify({ type: 'attachment', timestamp: '2026-09-01T00:00:03Z',
      attachment: { type: 'hook_success', command: 'node redline.mjs hook pre', stdout: 'x' } }),
  ]);
  assert.deepEqual(fires.map((f) => f.kind), ['post', 'pre', 'prompt']);   // 他人のフックは拾わない
});

test('壊れた行や空行があっても落ちない', () => {
  const { turns, fires } = foldResponses(['', 'not json', '{}', line('r1', '2026-09-01T00:00:00Z', [use])]);
  assert.equal(turns.length, 1);
  assert.equal(fires.length, 0);
});

/* ── 束ねなかった分（hook post）────────────────────── */

const human = (t) => JSON.stringify({ type: 'user', timestamp: t, message: { role: 'user', content: 'つぎ' } });
const resultLine = (t, id) => JSON.stringify({ type: 'user', timestamp: t,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
const useId = (name, id) => ({ type: 'tool_use', name, id });
const solo = (req, t, name = 'Bash') => line(req, t, [useId(name, 'tu_' + req)]);

test('foldResponses は tool_use の名前と id を持ち、人の発言で区間を切る', () => {
  const { turns } = foldResponses([
    human('2026-09-02T00:00:00Z'),
    line('r1', '2026-09-02T00:00:01Z', [useId('Read', 'a'), useId('Grep', 'b')]),
    resultLine('2026-09-02T00:00:02Z', 'a'),
    resultLine('2026-09-02T00:00:02Z', 'b'),
    human('2026-09-02T00:01:00Z'),
    solo('r2', '2026-09-02T00:01:01Z'),
  ]);
  assert.deepEqual(turns[0].names, ['Read', 'Grep']);
  assert.deepEqual(turns[0].ids, ['a', 'b']);
  assert.equal(turns[0].seg, 1);
  assert.equal(turns[1].seg, 2);   // tool_result の行では区間は進まない
});

test('1ターンに束ねた4本が直列に実行されても言わない（2026-09-02 の誤発火）', () => {
  // 1応答の tool_use が届いた順に4行へ割れ、結果が4〜5秒おきに返る＝実際の transcript の形
  const lines = [
    human('2026-09-02T00:41:18Z'),
    line('r1', '2026-09-02T00:41:34Z', [useId('Bash', 'b1')]),
    resultLine('2026-09-02T00:41:35Z', 'b1'),
    line('r1', '2026-09-02T00:41:36Z', [useId('Bash', 'b2')]),
    line('r1', '2026-09-02T00:41:36Z', [useId('Bash', 'b3')]),
    resultLine('2026-09-02T00:41:39Z', 'b2'),
    line('r1', '2026-09-02T00:41:40Z', [useId('Bash', 'b4')]),
    resultLine('2026-09-02T00:41:43Z', 'b3'),
    resultLine('2026-09-02T00:41:45Z', 'b4'),
  ];
  const { turns } = foldResponses(lines);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].tools, 4);
  for (const id of ['b1', 'b2', 'b3', 'b4']) assert.equal(bundleVerdict(turns, id), '');
});

test('同じツールが3応答続けて1本ずつなら、4つ目の応答で言う', () => {
  const lines = [
    human('2026-09-02T00:00:00Z'),
    solo('r1', '2026-09-02T00:00:10Z'), resultLine('2026-09-02T00:00:15Z', 'tu_r1'),
    solo('r2', '2026-09-02T00:00:30Z'), resultLine('2026-09-02T00:00:35Z', 'tu_r2'),
    solo('r3', '2026-09-02T00:00:50Z'), resultLine('2026-09-02T00:00:55Z', 'tu_r3'),
  ];
  // 3つ目までは今の応答がまだ続くかもしれないので黙る
  assert.equal(bundleVerdict(foldResponses(lines).turns, 'tu_r3'), '');
  // 4つ目の応答は、まだ1本しか届いていなくても手前3つが確定しているので言う
  lines.push(solo('r4', '2026-09-02T00:01:10Z'));
  assert.equal(bundleVerdict(foldResponses(lines).turns, 'tu_r4'), 'Bash');
  // 4つ目が束ねてあっても、言うのは手前3つの話
  lines.push(line('r4', '2026-09-02T00:01:11Z', [useId('Bash', 'tu_r4b')]));
  assert.equal(bundleVerdict(foldResponses(lines).turns, 'tu_r4b'), 'Bash');
});

test('人の発言をまたいだ1本ずつは数えない', () => {
  const lines = [
    human('2026-09-02T00:00:00Z'), solo('r1', '2026-09-02T00:00:10Z'),
    human('2026-09-02T00:01:00Z'), solo('r2', '2026-09-02T00:01:10Z'),
    human('2026-09-02T00:02:00Z'), solo('r3', '2026-09-02T00:02:10Z'),
    human('2026-09-02T00:03:00Z'), solo('r4', '2026-09-02T00:03:10Z'),
  ];
  assert.equal(bundleVerdict(foldResponses(lines).turns, 'tu_r4'), '');
});

test('ツールが混ざる、束ねてある応答が挟まる、文だけの応答は数えない', () => {
  const mix = [human('2026-09-02T00:00:00Z'), solo('r1', '2026-09-02T00:00:10Z', 'Read'),
    solo('r2', '2026-09-02T00:00:20Z', 'Bash'), solo('r3', '2026-09-02T00:00:30Z', 'Read'),
    solo('r4', '2026-09-02T00:00:40Z', 'Read')];
  assert.equal(bundleVerdict(foldResponses(mix).turns, 'tu_r4'), '');

  const par = [human('2026-09-02T00:00:00Z'), solo('r1', '2026-09-02T00:00:10Z'),
    line('r2', '2026-09-02T00:00:20Z', [useId('Bash', 'p1'), useId('Bash', 'p2')]),
    solo('r3', '2026-09-02T00:00:30Z'), solo('r4', '2026-09-02T00:00:40Z')];
  assert.equal(bundleVerdict(foldResponses(par).turns, 'tu_r4'), '');

  // 文だけの応答（thinking/text）は飛ばして数える
  const txt = [human('2026-09-02T00:00:00Z'), solo('r1', '2026-09-02T00:00:10Z'),
    line('rt', '2026-09-02T00:00:15Z', [think]),
    solo('r2', '2026-09-02T00:00:20Z'), solo('r3', '2026-09-02T00:00:30Z'), solo('r4', '2026-09-02T00:00:40Z')];
  assert.equal(bundleVerdict(foldResponses(txt).turns, 'tu_r4'), 'Bash');
});

test('tool_use_id が見つからなければ最後の応答を今の応答とみなす', () => {
  const lines = [human('2026-09-02T00:00:00Z'), solo('r1', '2026-09-02T00:00:10Z'),
    solo('r2', '2026-09-02T00:00:20Z'), solo('r3', '2026-09-02T00:00:30Z'), solo('r4', '2026-09-02T00:00:40Z')];
  assert.equal(bundleVerdict(foldResponses(lines).turns, 'nope'), 'Bash');
  assert.equal(bundleVerdict(foldResponses(lines).turns, undefined), 'Bash');
  assert.equal(bundleVerdict([], 'x'), '');
});

test('言うのは手前が揃ったときだけ。一度言ったら 20 呼びは黙る', () => {
  const st = {};
  let now = 0;
  const fire = (run) => { now += 5000; return bundleDecide(st, 's', run, now); };
  assert.equal(fire(''), '');
  const msg = fire('Bash');
  assert.match(msg, /^\[nenpi\] Bash が 3/);
  assert.match(msg, /依存しているならこのまま/);
  for (let i = 0; i < 20; i++) assert.equal(fire('Bash'), '');
  assert.match(fire('Edit'), /Edit/);
});

test('8回言って直らなければ、そのセッションでは以後黙る', () => {
  const st = {};
  let now = 0;
  let said = 0;
  for (let i = 0; i < 400; i++) { now += 5000; if (bundleDecide(st, 's', 'Bash', now)) said++; }
  assert.equal(said, 8);   // 上限が無ければ 19 回鳴る
});

test('1日を過ぎたセッションの記録は台帳から落ち、旧版の呼び履歴も消す', () => {
  const now = Date.now();
  const st = { old: { calls: [], mute: 0, at: now - 2 * 86400e3 }, live: { calls: [{ name: 'Bash', t: 1 }], mute: 0, at: now } };
  bundleDecide(st, 'live', '', now);
  assert.equal(st.old, undefined);
  assert.equal(st.live.calls, undefined);
});


// ---- errors（ツール失敗の内訳） ----
const useLine = (id, name, model, effort, mid = 'm_' + id) => JSON.stringify({
  type: 'assistant', requestId: 'req_' + mid, effort,
  message: { id: mid, model, content: [{ type: 'tool_use', id, name, input: {} }], usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 10, cache_creation_input_tokens: 0 } },
});
const resLine = (id, text, isErr, t = '2026-09-03T00:00:00.000Z') => JSON.stringify({
  type: 'user', timestamp: t,
  message: { content: [{ type: 'tool_result', tool_use_id: id, content: text, ...(isErr ? { is_error: true } : {}) }] },
});

test('classifyError: 環境起因の文言だけを env にする', () => {
  assert.equal(classifyError('Permission for this action was denied by the Claude Code auto mode classifier'), 'env');
  assert.equal(classifyError("The user doesn't want to proceed with this tool use."), 'env');
  assert.equal(classifyError('EPERM: operation not permitted, uv_spawn C:\\WINDOWS\\x.exe'), 'env');
  assert.equal(classifyError('Exit code 1 lost focus: refusing to type into another window'), 'env');
  assert.equal(classifyError('Multiple Chrome browsers are connected to this account'), 'env');
  assert.equal(classifyError('Permission to use Bash with command x has been denied'), 'env');
  assert.equal(classifyError('File does not exist. Note: your current working directory is C:\\'), 'model');
  assert.equal(classifyError('Exit code 2 /usr/bin/bash: -c: line 1: unexpected EOF'), 'model');
  assert.equal(classifyError(''), 'model');
  assert.equal(classifyError(undefined), 'model');
});

test('tallyErrors: tool_result を発行元の model×effort と ツールに帰属させ、env/model を分ける', () => {
  const acc = emptyErrors();
  tallyErrors([
    useLine('t1', 'Bash', 'claude-fable-5-1', 'xhigh'),
    resLine('t1', 'ok', false),
    useLine('t2', 'Bash', 'claude-fable-5-1', 'xhigh'),
    resLine('t2', 'EPERM: operation not permitted, uv_spawn', true),
    useLine('t3', 'Read', 'claude-opus-5', 'xhigh'),
    resLine('t3', 'File does not exist.', true),
    useLine('t4', 'Bash', 'claude-fable-5-1', 'high'),
    resLine('t4', [{ type: 'text', text: 'Permission for this action was denied by the Claude Code auto mode' }], true),
    '', 'not json',
  ], acc);
  assert.equal(acc.results, 4);
  assert.equal(acc.errors, 3);
  assert.equal(acc.env, 2);
  assert.deepEqual(acc.byModelEffort['fable-5-1|xhigh'], { n: 2, e: 1, env: 1 });
  assert.deepEqual(acc.byModelEffort['opus-5|xhigh'], { n: 1, e: 1, env: 0 });
  assert.deepEqual(acc.byModelEffort['fable-5-1|high'], { n: 1, e: 1, env: 1 });
  assert.deepEqual(acc.byTool.Bash, { n: 3, e: 2, env: 2 });
  assert.deepEqual(acc.byTool.Read, { n: 1, e: 1, env: 0 });
  assert.equal(acc.texts['File does not exist.'], 1);
});

test('tallyErrors: 発行元が見つからない tool_result は ?|? に入る／since・until で時刻を絞れる', () => {
  const acc = emptyErrors();
  tallyErrors([resLine('nope', 'x', true)], acc);
  assert.deepEqual(acc.byModelEffort['?|?'], { n: 1, e: 1, env: 0 });
  assert.deepEqual(acc.byTool['?'], { n: 1, e: 1, env: 0 });

  const lines = [
    useLine('a', 'Bash', 'claude-fable-5-1', 'xhigh'), resLine('a', 'x', true, '2026-09-03T06:00:00.000Z'),
    useLine('b', 'Bash', 'claude-fable-5-1', 'high'), resLine('b', 'x', true, '2026-09-03T08:00:00.000Z'),
  ];
  const cut = Date.parse('2026-09-03T07:00:00.000Z');
  const before = tallyErrors(lines, emptyErrors(), { until: cut });
  const after = tallyErrors(lines, emptyErrors(), { since: cut });
  assert.deepEqual(Object.keys(before.byModelEffort), ['fable-5-1|xhigh']);
  assert.deepEqual(Object.keys(after.byModelEffort), ['fable-5-1|high']);
});

test('errorsJson: 収集役へ送る形は集計値だけ（エラー本文を含まない）', () => {
  const acc = emptyErrors();
  tallyErrors([useLine('t', 'Bash', 'claude-opus-5', 'xhigh'), resLine('t', 'secret path C:\\x', true)], acc);
  const j = errorsJson(acc);
  assert.deepEqual(Object.keys(j), ['toolResults', 'toolErrors', 'toolErrorsEnv', 'toolErrorRate', 'byModelEffort']);
  assert.equal(j.toolErrorRate, 100);
  assert.ok(!JSON.stringify(j).includes('secret'));
});

test('ENV_ERROR_WORDS: 収集役に写す文言に正規表現の特殊文字や引用符が無い', () => {
  for (const w of ENV_ERROR_WORDS) assert.ok(!/["'\\|()[\]]/.test(w), w);
});

test('envInt: 正の数値のときだけ環境変数を採る', () => {
  const saved = process.env.NENPI_TEST_INT;
  try {
    delete process.env.NENPI_TEST_INT;
    assert.equal(envInt('NENPI_TEST_INT', 7), 7);
    process.env.NENPI_TEST_INT = '12';
    assert.equal(envInt('NENPI_TEST_INT', 7), 12);
    for (const bad of ['', '0', '-3', 'abc']) {
      process.env.NENPI_TEST_INT = bad;
      assert.equal(envInt('NENPI_TEST_INT', 7), 7, bad);
    }
  } finally {
    if (saved === undefined) delete process.env.NENPI_TEST_INT; else process.env.NENPI_TEST_INT = saved;
  }
});
