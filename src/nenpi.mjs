#!/usr/bin/env node
/**
 * nenpi (燃費, "fuel economy") — measures where a Claude Code session burns its tokens.
 *
 *   nenpi report   [--days 30]   fuel report, diffed against a saved baseline
 *   nenpi top      [--days 30]   the heaviest sessions
 *   nenpi baseline [--days 30]   freeze the current numbers as the baseline
 *   nenpi quality  [--days 30]   precise report, with the intelligence and speed gauges
 *   nenpi effect   [--days 30]   compare the turns right after a nudge against normal ones
 *   nenpi errors   [--days 30]   tool failures, split into environment-caused and model-caused
 *   nenpi hook pre|prompt|post   hook entry points (event JSON on stdin)
 *
 * Common options: --days N, --lang en|ja (or NENPI_LANG), --json.
 *
 * The unit of counting is message.id, not the line: one API response is one charge.
 * Claude Code splits a single response into separate JSONL lines per thinking / text /
 * tool_use block and copies the same usage onto every one of them, so counting lines
 * double-counts. Parallel tool use is likewise regrouped by requestId before measuring.
 *
 * The central metric is residency cost = tool_result tokens x the number of turns that
 * followed it. cache_read re-reads the entire context on every turn, so the earlier a
 * large output enters the conversation, the more it ends up costing.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HOME = os.homedir();
const PROJECTS = path.join(HOME, '.claude', 'projects');
const STATE_DIR = process.env.NENPI_STATE_DIR || path.join(HOME, '.claude', 'nenpi'); // baseline + nudge state
try { fs.mkdirSync(STATE_DIR, { recursive: true }); } catch { /* read-only paths still work */ }

// Before 0.1.0 the state lived in ~/.claude/tools. Reads fall back there, so an
// upgrade does not silently lose the baseline you have been measuring against —
// `nenpi baseline` would be the obvious way to make the message go away, and it
// overwrites the very thing that was missing. Writes always go to STATE_DIR.
const LEGACY_STATE_DIR = path.join(HOME, '.claude', 'tools');
export function readStateFrom(dirs, name) {
  for (const dir of dirs) {
    try { return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { /* try the next */ }
  }
  return null;
}
export const readState = (name) => readStateFrom([STATE_DIR, LEGACY_STATE_DIR], name);
const IMG_TOK = 1600;        // rough token cost of one image block
const BYTES_PER_TOK = 3.5;   // rough bytes-per-token for mixed Japanese and English
const W = { in: 1, write: 1.25, read: 0.1, out: 5 }; // weights, in input-token equivalents

// Output language. English unless NENPI_LANG (or --lang) says otherwise, or the OS
// locale is Japanese. Resolved per call so --lang and tests can change it at runtime.
// Windows sets none of the POSIX locale variables, so Intl is the fallback there.
function lang() {
  const v = (process.env.NENPI_LANG || '').toLowerCase();
  if (v.startsWith('ja')) return 'ja';
  if (v.startsWith('en')) return 'en';
  let loc = (process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || '').toLowerCase();
  if (!loc) {
    try { loc = Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase(); } catch { loc = ''; }
  }
  return loc.startsWith('ja') ? 'ja' : 'en';
}
export const t = (en, ja) => (lang() === 'ja' ? ja : en);

// Every threshold below can be overridden from the environment, so the hooks can be
// tuned per machine without editing this file. A non-numeric value falls back.
export function envInt(name, def) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : def;
}

const tok = (b) => Math.round(b / BYTES_PER_TOK);
const M = (n) => (n / 1e6).toFixed(n < 1e7 ? 1 : 0) + 'M';
const pct = (a, b) => (100 * a / (b || 1)).toFixed(1) + '%';

function sessionFiles(days) {
  const cutoff = Date.now() - days * 86400e3;
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(PROJECTS); } catch { return out; }
  for (const d of dirs) {
    const dir = path.join(PROJECTS, d);
    let st; try { st = fs.statSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const p = path.join(dir, f);
      let s; try { s = fs.statSync(p); } catch { continue; }
      if (s.mtimeMs < cutoff) continue;
      out.push({ path: p, project: d, mtime: s.mtimeMs });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

function blockSize(content) {
  let t = 0, imgs = 0;
  if (typeof content === 'string') return { tok: tok(content.length), imgs: 0 };
  if (Array.isArray(content)) {
    for (const b of content) {
      if (b.type === 'image') { imgs++; t += IMG_TOK; }
      else if (b.type === 'text') t += tok((b.text || '').length);
      else t += tok(JSON.stringify(b).length);
    }
  }
  return { tok: t, imgs };
}

function scan(days) {
  const acc = {
    sessions: [], turns: 0, usage: { in: 0, write: 0, read: 0, out: 0 },
    resid: {}, count: {}, injected: {}, imgs: {},
    toolUsesTotal: 0, toolTurns: 0, parallelTurns: 0,
    ctx: [], baselines: [], residTotal: 0, files: 0,
  };
  for (const { path: p, project } of sessionFiles(days)) {
    let lines;
    try { lines = fs.readFileSync(p, 'utf8').split('\n'); } catch { continue; }
    acc.files++;
    const id2name = {}, events = [];
    // The billing unit is one API response = one message.id, not one line.
    const seenMsg = new Set();   // keeps the same usage from being counted twice
    const toolByReq = {};        // requestId -> how many tools that response called
    let lineNo = 0;
    const s = { project, file: p, turns: 0, read: 0, write: 0, out: 0, ctxSum: 0, ctxMax: 0 };
    let first = true;
    for (const ln of lines) {
      if (!ln.trim()) continue;
      let o; try { o = JSON.parse(ln); } catch { continue; }
      const content = o.message?.content;
      lineNo++;
      if (o.type === 'assistant') {
        // Claude Code splits one API response into a separate line per
        // thinking / text / tool_use block, and every one of those lines carries
        // the same message.id and the same usage. Summing per line counts the
        // same charge several times over (+82% here, measured).
        const mid = o.message?.id || o.requestId || null;
        const dup = mid !== null && seenMsg.has(mid);
        if (mid !== null) seenMsg.add(mid);
        const u = o.message?.usage;
        if (u && !dup) {
          s.turns++; acc.turns++;
          const cr = u.cache_read_input_tokens || 0;
          const cc = u.cache_creation_input_tokens || 0;
          const ip = u.input_tokens || 0;
          s.read += cr; s.write += cc; s.out += u.output_tokens || 0;
          acc.usage.read += cr; acc.usage.write += cc;
          acc.usage.in += ip; acc.usage.out += u.output_tokens || 0;
          const ctx = cr + cc + ip;
          acc.ctx.push(ctx); s.ctxSum += ctx; if (ctx > s.ctxMax) s.ctxMax = ctx;
          if (first) { acc.baselines.push(cc + ip); first = false; }
        }
        if (Array.isArray(content)) {
          // Whether a response bundled its tool calls cannot be told from a
          // single line. Only after regrouping the split lines by requestId does
          // "how many tools this one response called" become visible.
          const rid = o.requestId || mid || ('line#' + lineNo);
          let n = 0;
          for (const b of content) if (b.type === 'tool_use') { id2name[b.id] = b.name; n++; }
          if (n > 0) { toolByReq[rid] = (toolByReq[rid] || 0) + n; acc.toolUsesTotal += n; }
        }
      }
      if (o.type === 'user' && Array.isArray(content)) {
        for (const b of content) {
          if (b.type !== 'tool_result') continue;
          const name = id2name[b.tool_use_id] || 'unknown';
          const sz = blockSize(b.content);
          events.push([name, sz.tok, s.turns]);
          acc.injected[name] = (acc.injected[name] || 0) + sz.tok;
          acc.count[name] = (acc.count[name] || 0) + 1;
          acc.imgs[name] = (acc.imgs[name] || 0) + sz.imgs;
        }
      }
    }
    for (const n of Object.values(toolByReq)) { acc.toolTurns++; if (n > 1) acc.parallelTurns++; }
    if (!s.turns) continue;
    for (const [name, t, at] of events) {
      const r = t * Math.max(0, s.turns - at);
      acc.resid[name] = (acc.resid[name] || 0) + r;
      acc.residTotal += r;
    }
    acc.sessions.push(s);
  }
  return acc;
}

/* ---------------- baseline (what the next run is compared against) ---------------- */
const BASELINE = path.join(STATE_DIR, 'nenpi-baseline.json');
// Version of the counting method. 1 = the per-line era (double counting, and
// bundling could not be detected). 2 = deduplicate by message.id and detect
// bundling by requestId. A baseline from a different version is not comparable.
const CALC = 2;

// Of everything the report prints, these are the few worth tracking week to week.
function indicators(a) {
  const u = a.usage;
  const eq = u.in * W.in + u.write * W.write + u.read * W.read + u.out * W.out;
  const c = [...a.ctx].sort((x, y) => x - y);
  const tot = c.reduce((x, y) => x + y, 0) || 1;
  const over = c.filter(v => v > 4e5).reduce((x, y) => x + y, 0);
  const long = a.sessions.filter(s => s.turns > 500).reduce((x, s) => x + s.read, 0);
  return {
    cacheReadShare: 100 * u.read * W.read / (eq || 1),
    ctxMedian: c[Math.floor(c.length * .5)] || 0,
    ctxP90: c[Math.floor(c.length * .9)] || 0,
    over400kShare: 100 * over / tot,
    parallelRate: a.toolTurns ? 100 * a.parallelTurns / a.toolTurns : 0,
    longSessionShare: 100 * long / (u.read || 1),
    perTurn: u.read / (a.turns || 1),
    turns: a.turns,
    sessions: a.files,
  };
}

// [[english, japanese], unit, which direction is an improvement]
const LABELS = {
  cacheReadShare:   [['cache_read share of all spend', 'cache_read が総消費に占める割合'], '%', 'down'],
  ctxMedian:        [['context per turn (median)', '1ターンの文脈（中央値）'], 'tok', 'down'],
  ctxP90:           [['context per turn (p90)', '1ターンの文脈（p90）'], 'tok', 'down'],
  over400kShare:    [['cache_read from turns over 400K tok', '40万tok超のターンの cache_read 比'], '%', 'down'],
  parallelRate:     [['tool calls bundled into one turn', '複数ツールを1ターンに束ねた割合'], '%', 'up'],
  longSessionShare: [['cache_read from sessions over 500 turns', '500ターン超セッションの cache_read 比'], '%', 'down'],
  perTurn:          [['cache_read per turn', '1ターンあたり cache_read'], 'tok', 'down'],
};

// Both windows are rates or medians, so they stay comparable; the shorter one is noisier.
const windowNote = (baseDays, nowDays) => t(
  'note: the baseline covers the last ' + baseDays + ' days and this run the last ' + nowDays
    + '. Every metric is a rate or a median, so they compare, but the shorter window is noisier.',
  '※ 基準は直近' + baseDays + '日、今回は直近' + nowDays
    + '日。指標はすべて率か中央値なので窓が違っても比べられるが、短い側は揺れが大きい。');

function fmtVal(v, unit) {
  if (unit === '%') return v.toFixed(1) + '%';
  return Math.round(v).toLocaleString();
}

function printDiff(now, nowDays) {
  let prev;
  prev = readState('nenpi-baseline.json');
  if (!prev) return;
  if ((prev.calc || 1) !== CALC) {
    console.log('## ' + t('Baseline comparison — not possible', '基準との比較 — できない'));
    console.log('  ' + t('The baseline (' + prev.savedAt.slice(0, 10) + ') was computed with v' + (prev.calc || 1)
      + ', this run uses v' + CALC + '. Per-line double counting was fixed, so the numbers are not continuous.',
      '基準（' + prev.savedAt.slice(0, 10) + '）は計算方式 v' + (prev.calc || 1)
      + '、今は v' + CALC + '。行単位の二重計上を直したので数字が地続きでない。'));
    console.log('  ' + t('Retake it with `nenpi baseline --days ' + prev.days + '`.',
      '`nenpi baseline --days ' + prev.days + '` で取り直すこと。'));
    console.log('');
    return;
  }
  console.log('## ' + t('Compared with the baseline', '基準との比較')
    + t(' (baseline: ' + prev.savedAt.slice(0, 10) + ', last ' + prev.days + ' days, ' + prev.i.sessions + ' sessions)',
        '（基準: ' + prev.savedAt.slice(0, 10) + ' / 直近' + prev.days + '日 ' + prev.i.sessions + 'セッション）'));
  if (prev.days !== nowDays) console.log('  ' + windowNote(prev.days, nowDays));
  console.log('  ' + padR(t('metric', '指標'), 44) + padL(t('baseline', '基準'), 9) + '  → '
    + padL(t('now', '今'), 9) + '  ' + padL(t('change', '変化'), 6));
  for (const [k, [label, unit, good]] of Object.entries(LABELS)) {
    const a = prev.i[k], b = now[k];
    if (a === undefined || b === undefined) continue;
    const d = b - a;
    const rel = a ? (100 * d / a) : 0;
    const better = good === 'down' ? d < 0 : d > 0;
    const mark = Math.abs(rel) < 3 ? '  —' : (better ? t(' better', ' 改善') : t(' worse', ' 悪化'));
    console.log('  ' + padR(t(...label), 44) + fmtVal(a, unit).padStart(9) + ' → ' + fmtVal(b, unit).padStart(9)
      + '  ' + ((rel >= 0 ? '+' : '') + rel.toFixed(0) + '%').padStart(6) + mark);
  }
  console.log('');
}

function baseline(days) {
  const a = scan(days);
  if (!a.turns) { console.log(t('no sessions in this window', '対象セッションなし')); return; }
  const rec = { savedAt: new Date().toISOString(), calc: CALC, days, i: indicators(a) };
  fs.writeFileSync(BASELINE, JSON.stringify(rec, null, 2) + '\n', 'utf8');
  console.log(t('baseline saved: ', '基準を保存: ') + BASELINE);
  for (const [k, [label, unit]] of Object.entries(LABELS)) {
    console.log('  ' + padR(t(...label), 44) + fmtVal(rec.i[k], unit).padStart(10));
  }

  const qa = scanQuality(days);
  if (qa.turns) {
    const rec2 = Object.assign({ savedAt: rec.savedAt, calc: CALC }, summaryJson(qa, days));
    fs.writeFileSync(QBASE, JSON.stringify(rec2, null, 2) + '\n', 'utf8');
    console.log('  ' + t('intelligence and speed baseline saved too: ', '知能計・速度計の基準も保存: ') + QBASE);
  }
  console.log('');
  console.log(t('Next time both `nenpi report --days ' + days + '` and `nenpi quality --days ' + days + '` will show a diff.',
    '次回は `nenpi report --days ' + days + '` と `nenpi quality --days ' + days + '` の両方で差分が出る。'));
}

function report(days) {
  const a = scan(days);
  if (!a.turns) { console.log(t('no sessions in this window', '対象セッションなし')); return; }
  const u = a.usage;
  const eq = u.in * W.in + u.write * W.write + u.read * W.read + u.out * W.out;
  console.log('# nenpi — ' + t('last ' + days + (days === 1 ? ' day' : ' days') + ' / ' + a.files + ' sessions / ' + a.turns.toLocaleString() + ' turns',
    '直近' + days + '日 / ' + a.files + 'セッション / ' + a.turns.toLocaleString() + 'ターン'));
  console.log('');
  printDiff(indicators(a), days);
  const arrow = t(' → weighted ', ' → 換算 ');
  console.log('## ' + t('Measured tokens', '実測トークン'));
  console.log('  ' + padR('cache_read  ' + t('re-reading the context every turn', '毎ターン文脈を読み直す'), 44)
    + M(u.read).padStart(8) + arrow + M(u.read * W.read).padStart(7) + '  ' + pct(u.read * W.read, eq));
  console.log('  ' + padR('cache_write ' + t('adding to the context', '文脈に新しく積む'), 44)
    + M(u.write).padStart(8) + arrow + M(u.write * W.write).padStart(7) + '  ' + pct(u.write * W.write, eq));
  console.log('  ' + padR('output      ' + t('replies and thinking', '返答・thinking'), 44)
    + M(u.out).padStart(8) + arrow + M(u.out * W.out).padStart(7) + '  ' + pct(u.out * W.out, eq));
  console.log('  ' + padR(t('total (in input-token equivalents)', '合計（入力トークン換算）'), 44) + M(eq).padStart(8));
  console.log('');

  const c = [...a.ctx].sort((x, y) => x - y);
  const q = (f) => c[Math.floor(c.length * f)] || 0;
  const b = [...a.baselines].sort((x, y) => x - y);
  const baseline = b[Math.floor(b.length / 2)] || 0;
  console.log('## ' + t('Context length per turn', '1ターンあたりの文脈の長さ'));
  console.log('  ' + t('median ', '中央値 ') + q(.5).toLocaleString() + ' / p90 ' + q(.9).toLocaleString()
    + t(' / max ', ' / 最大 ') + (c[c.length - 1] || 0).toLocaleString());
  console.log('  ' + t('fixed startup cost (median) ', '起動時の固定コスト（中央値） ') + baseline.toLocaleString() + ' tok');
  const bands = [[0, 1e5], [1e5, 2e5], [2e5, 4e5], [4e5, 6e5], [6e5, 1e9]];
  const tot = c.reduce((x, y) => x + y, 0);
  for (const [lo, hi] of bands) {
    const sel = c.filter(v => v >= lo && v < hi);
    const sum = sel.reduce((x, y) => x + y, 0);
    const label = (lo / 1000) + 'K-' + (hi > 1e8 ? '∞' : (hi / 1000) + 'K');
    console.log('    ' + label.padEnd(10) + String(sel.length).padStart(6) + t(' turns  ', 'ターン  ') + M(sum).padStart(7) + '  ' + pct(sum, tot).padStart(6));
  }
  console.log('');

  console.log('## ' + t('Residency cost (tokens injected x turns that followed) = what cache_read really is',
    '滞在コスト（投入tok × それ以降のターン数）= cache_read の実体'));
  console.log('  ' + padL(t('resid', '滞在'), 7) + padL(t('share', '比率'), 7) + padL(t('calls', '件数'), 7)
    + padL(t('injected', '投入tok'), 9) + padL(t('avg', '平均/回'), 8) + padL(t('imgs', '画像'), 6) + '  ' + t('tool', 'ツール'));
  for (const [k, v] of Object.entries(a.resid).sort((x, y) => y[1] - x[1]).slice(0, 12)) {
    console.log('  ' + M(v).padStart(7) + ' ' + pct(v, a.residTotal).padStart(6) + ' ' + String(a.count[k]).padStart(6)
      + ' ' + M(a.injected[k] || 0).padStart(8) + ' ' + String(Math.round((a.injected[k] || 0) / a.count[k])).padStart(7)
      + ' ' + String(a.imgs[k] || 0).padStart(5) + '  ' + k);
  }
  console.log('');

  const parRate = a.toolTurns ? 100 * a.parallelTurns / a.toolTurns : 0;
  console.log('## ' + t('Turn efficiency', 'ターン効率'));
  console.log('  ' + t('tool_use ' + a.toolUsesTotal.toLocaleString() + ' calls / ' + a.toolTurns.toLocaleString()
    + ' tool turns = ' + (a.toolUsesTotal / (a.toolTurns || 1)).toFixed(2) + ' per turn',
    'tool_use ' + a.toolUsesTotal.toLocaleString() + ' 回 / ツール実行ターン ' + a.toolTurns.toLocaleString()
    + ' = 1ターンあたり ' + (a.toolUsesTotal / (a.toolTurns || 1)).toFixed(2) + ' 個'));
  console.log('  ' + t('share of tool turns that bundled more than one call: ',
    '複数ツールを1ターンに束ねられていた割合: ') + parRate.toFixed(1) + '%');
  console.log('');

  console.log('## ' + t('Diagnosis', '診断'));
  const warn = '  ' + t('[warn] ', '[警告] ');
  const over = c.filter(v => v > 4e5);
  const overSum = over.reduce((x, y) => x + y, 0);
  if (overSum / (tot || 1) > 0.2) console.log(warn + t(
    'turns over 400K tok account for ' + pct(overSum, tot) + ' of cache_read -> lower autoCompactWindow',
    '文脈40万tok超のターンが cache_read の ' + pct(overSum, tot) + ' を占める → autoCompactWindow を下げる'));
  if (parRate < 10) console.log(warn + t(
    'parallel tool calls ' + parRate.toFixed(1) + '% -> bundle independent Read/Bash calls into one turn',
    '並列ツール呼び出し ' + parRate.toFixed(1) + '% → 独立した Read/Bash は1ターンに束ねる'));
  if (baseline > 25000) console.log(warn + t(
    'startup cost ' + baseline.toLocaleString() + ' tok x ' + a.turns.toLocaleString() + ' turns = ' + M(baseline * a.turns)
      + ' -> trim skillListingMaxDescChars and unused MCP servers',
    '起動時固定コスト ' + baseline.toLocaleString() + 'tok × ' + a.turns.toLocaleString() + 'ターン = ' + M(baseline * a.turns)
      + ' → skillListingMaxDescChars / 不要MCP を削る'));
  const long = a.sessions.filter(s => s.turns > 500);
  if (long.length) {
    const lr = long.reduce((x, s) => x + s.read, 0);
    console.log(warn + t(
      long.length + ' sessions over 500 turns account for ' + pct(lr, u.read) + ' of cache_read -> split them up with /clear',
      '500ターン超の ' + long.length + ' セッションが cache_read の ' + pct(lr, u.read) + ' → 区切って /clear する'));
  }
}

function top(days) {
  const a = scan(days);
  console.log('# ' + t('Heaviest sessions (last ' + days + ' days)', '重いセッション（直近' + days + '日）'));
  console.log('');
  console.log(' ' + padL('cache_read', 9) + padL(t('turns', 'ターン'), 7) + padL(t('avg ctx', '平均文脈'), 11)
    + padL(t('max ctx', '最大文脈'), 12) + '  ' + t('project', 'プロジェクト'));
  for (const s of a.sessions.sort((x, y) => y.read - x.read).slice(0, 20)) {
    console.log('  ' + M(s.read).padStart(8) + ' ' + String(s.turns).padStart(6)
      + ' ' + Math.round(s.ctxSum / s.turns).toLocaleString().padStart(10)
      + ' ' + s.ctxMax.toLocaleString().padStart(11) + '  ' + s.project);
  }
}

/* ---------------- PreToolUse hook ---------------- */
/* ── optional airframe integration ─────────────────────────
   airframe (a separate tool of mine) keeps the current mode in `.spar/sortie.json`.
   In "cruise" — divergent work, drafting, naming, design — its limiter and its
   completion gate both go quiet, because putting a limiter on a draft is the wrong
   move. The same goes for nenpi's three nudges: being told "this turn cost $0.99"
   in the middle of thinking only makes the thinking cheaper. Trim during "strike"
   (convergent work) and not before. No airframe found means strike, so nenpi runs
   perfectly well on its own. */
export function sparMode(cwd) {
  const base = process.env.SPAR_HOME
    || (cwd ? path.join(cwd, '.spar') : null);
  if (!base) return 'strike';
  try {
    const j = JSON.parse(fs.readFileSync(path.join(base, 'sortie.json'), 'utf8'));
    return j.mode === 'cruise' ? 'cruise' : 'strike';
  } catch { return 'strike'; }
}

export const muted = (cwd) => sparMode(cwd) === 'cruise';

const NL_CH = String.fromCharCode(10);
const IMG_RE = /\.(png|jpe?g|gif|webp|bmp|pdf)$/i;
const BIG_FILE = envInt('NENPI_BIG_FILE', 60 * 1024); // a full-file Read above this size gets its window cut
const READ_LIMIT = envInt('NENPI_READ_LIMIT', 400);

function hookPre() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { raw += d; });
  process.stdin.on('end', () => {
    let ev; try { ev = JSON.parse(raw); } catch { process.exit(0); }
    const name = ev.tool_name || ev.toolName;
    const input = ev.tool_input || ev.toolInput || {};
    if (name !== 'Read' || muted(ev.cwd)) process.exit(0);
    const fp = input.file_path || '';
    if (!fp || IMG_RE.test(fp) || input.limit || input.offset || input.pages) process.exit(0);
    let st; try { st = fs.statSync(fp); } catch { process.exit(0); }
    if (st.size <= BIG_FILE) process.exit(0);
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: Object.assign({}, input, { limit: READ_LIMIT }),
        additionalContext: '[nenpi] ' + t(
          path.basename(fp) + ' is ' + Math.round(st.size / 1024) + 'KB. Read in full it would sit in the '
            + 'context and be re-sent every turn, so it was cut to the first ' + READ_LIMIT
            + ' lines. Locate what you need with Grep first, then read it with offset/limit.',
          path.basename(fp) + ' は ' + Math.round(st.size / 1024)
            + 'KB。全文は文脈に居座り毎ターン再送されるため先頭 ' + READ_LIMIT
            + ' 行に切った。必要な箇所は Grep で当たりを付けてから offset/limit で読むこと。'),
      },
    }));
    process.exit(0);
  });
}

/* ================= quality — intelligence, speed and attribution ================= */

// Phrases that mean "no, not that". The list is a judgement call, so the report
// prints it and you can audit it. Matched case-insensitively; a `.` stands in for an
// apostrophe so both ' and ’ are caught.
export const CORRECTION_WORDS = [
  '違う', 'ちがう', 'じゃなくて', 'そうじゃな', 'やり直', '間違っ', 'まちがっ',
  '戻して', '元に戻', '勝手に', '言ってない', '頼んでない', '聞いてない',
  'that.s not', 'not what i', 'i didn.t ask', 'i didn.t say', 'i never said',
  'undo that', 'revert that', 'put it back', 'start over', 'you broke',
  'don.t do that', 'stop doing that', 'without asking',
];
const CORRECTION_RE = new RegExp(CORRECTION_WORDS.join('|'), 'i');

export const BANDS = [[0, 1e5], [1e5, 2e5], [2e5, 4e5], [4e5, 6e5], [6e5, Infinity]];
export const bandOf = (ctx) => {
  for (let i = 0; i < BANDS.length; i++) if (ctx >= BANDS[i][0] && ctx < BANDS[i][1]) return i;
  return BANDS.length - 1;
};
export const bandLabel = (i) => {
  const [lo, hi] = BANDS[i];
  return (lo / 1000) + 'K-' + (hi === Infinity ? '∞' : (hi / 1000) + 'K');
};

const REWORK_WINDOW = 5;      // a re-edit within this many turns counts as rework
const MENTION_CAP = 20000;    // chars scanned per file when deciding a Read was wasted
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);
const baseName = (p) => String(p || '').replace(/\\/g, '/').split('/').pop();
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const shortHook = (cmd) => {
  const c = String(cmd);
  const m = [...c.matchAll(/([\w.-]+)\.(mjs|cjs|js|ps1|sh|py)/g)].pop();
  if (!m) return c.split(/\s+/)[0];
  return (m[1] + ' ' + c.slice(m.index + m[0].length).replace(/^"?\s*/, '')).trim();
};

// Text a hook injected survives inside tool_result as "[name] ...".
// Injections from SessionStart / UserPromptSubmit / Stop do not survive in the
// transcript at all — only their duration can be recovered.
// What a hook actually did is recorded in type:"attachment" hook_* entries:
//   hook_success            ... command / durationMs / stdout (additionalContext lands here)
//   hook_cancelled          ... cut off by the timeout
//   hook_non_blocking_error ... failed but did not block
// hookAdditionalContext (on system lines) is always an empty array, so it is
// useless here — checked against real transcripts.
const HOOK_ATT = new Set(['hook_success', 'hook_cancelled', 'hook_non_blocking_error']);

// Pull out the text a hook pushed into the context: additionalContext when the
// stdout is JSON, otherwise the raw stdout (how SessionStart / UserPromptSubmit
// hooks usually write).
export function injectedText(stdout) {
  const raw = String(stdout || '');
  if (!raw.trim()) return '';
  try {
    const j = JSON.parse(raw);
    const c = j?.hookSpecificOutput?.additionalContext ?? j?.additionalContext;
    return typeof c === 'string' ? c : '';
  } catch { return raw; }
}

export const POS = [[1, 20], [21, 50], [51, 100], [101, 200], [201, Infinity]];
export const posOf = (t) => {
  for (let i = 0; i < POS.length; i++) if (t >= POS[i][0] && t <= POS[i][1]) return i;
  return POS.length - 1;
};
export const posLabel = (i) => {
  const [lo, hi] = POS[i];
  return hi === Infinity ? lo + '-' : lo + '-' + hi;
};

function emptyPos() {
  return POS.map(() => ({ turns: 0, tr: 0, err: 0, reread: 0, rework: 0, ctx: [], dur: [] }));
}

function emptyBands() {
  return BANDS.map(() => ({ turns: 0, tr: 0, err: 0, reread: 0, rework: 0, dur: [] }));
}

/**
 * Turn one session's records into the raw material for the fuel, intelligence,
 * speed and attribution gauges. A pure function that touches no files, so the
 * tests can feed it synthetic sessions.
 */
export function analyzeSession(records) {
  const s = {
    turns: 0, humanTurns: 0, hasTurnDuration: false,
    ctxByTurn: [], effort: {}, days: {},
    toolResults: 0, toolErrors: 0,
    userPrompts: 0, corrections: 0,
    reads: 0, reread: 0, rereadAcrossCompact: 0, wasted: 0,
    edits: 0, rework: 0,
    denials: 0, interrupts: 0,
    durations: [], compacts: [],
    hooks: {}, att: {}, attEvents: {}, hookCtxTok: 0, hookCtxCount: 0, hookErrors: 0,
    cost: null, byBand: emptyBands(), byPos: emptyPos(),
  };
  const seenMsg = new Set();
  const readEv = [], editEv = [], mentions = [], trTurns = [], errTurns = [];

  let seq = 0;
  for (const o of records) {
    seq++;
    const content = o.message?.content;

    if (o.type === 'assistant') {
      const mid = o.message?.id || o.requestId || null;
      const dup = mid !== null && seenMsg.has(mid);
      if (mid !== null) seenMsg.add(mid);
      const u = o.message?.usage;
      if (u && !dup) {
        s.turns++;
        const cr = u.cache_read_input_tokens || 0, cc = u.cache_creation_input_tokens || 0;
        const ip = u.input_tokens || 0, op = u.output_tokens || 0;
        s.ctxByTurn.push(cr + cc + ip);
        if (o.effort) s.effort[o.effort] = (s.effort[o.effort] || 0) + 1;
        const d = (o.timestamp || '').slice(0, 10);
        if (d) {
          const day = s.days[d] || (s.days[d] = { turns: 0, read: 0, write: 0, in: 0, out: 0 });
          day.turns++; day.read += cr; day.write += cc; day.in += ip; day.out += op;
        }
      }
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b.type === 'tool_use') {
            const inp = b.input || {};
            const fp = inp.file_path || inp.path || '';
            if (b.name === 'Read' && fp) readEv.push({ p: fp, turn: s.turns, seq });
            else {
              if (EDIT_TOOLS.has(b.name) && fp) editEv.push({ p: fp, turn: s.turns });
              // A Read does not count as "using" what it read; re-reads are a
              // separate metric.
              mentions.push({ turn: s.turns, text: JSON.stringify(inp).slice(0, MENTION_CAP) });
            }
          } else if (b.type === 'text') {
            mentions.push({ turn: s.turns, text: (b.text || '').slice(0, MENTION_CAP) });
          }
        }
      }
      continue;
    }

    if (o.type === 'user') {
      if (o.toolDenialKind) s.denials++;
      if (o.interruptedMessageId) s.interrupts++;
      const isTR = Array.isArray(content) && content.some((b) => b.type === 'tool_result');
      if (isTR) {
        for (const b of content) {
          if (b.type !== 'tool_result') continue;
          s.toolResults++; trTurns.push(s.turns);
          if (b.is_error) { s.toolErrors++; errTurns.push(s.turns); }
        }
      } else if (!o.isMeta && !o.isCompactSummary) {
        const txt = typeof content === 'string' ? content
          : Array.isArray(content) ? content.filter((b) => b.type === 'text').map((b) => b.text || '').join('\n') : '';
        if (txt.trim()) {
          s.userPrompts++;
          if (CORRECTION_RE.test(txt)) s.corrections++;
        }
      }
      continue;
    }

    if (o.type === 'system') {
      if (o.subtype === 'turn_duration' && typeof o.durationMs === 'number') {
        s.hasTurnDuration = true; s.humanTurns++;
        s.durations.push({ ms: o.durationMs, turn: s.turns });
      }
      if (o.compactMetadata) {
        const c = o.compactMetadata;
        s.compacts.push({
          turn: s.turns, seq, pre: c.preTokens || 0, post: c.postTokens || 0,
          dropped: c.cumulativeDroppedTokens || 0, trigger: c.trigger || '?',
        });
      }
      if (Array.isArray(o.hookInfos)) {
        for (const h of o.hookInfos) {
          const k = shortHook(h.command || '?');
          const e = s.hooks[k] || (s.hooks[k] = { n: 0, ms: 0, timed: 0 });
          e.n++;
          if (typeof h.durationMs === 'number') { e.ms += h.durationMs; e.timed++; }
        }
      }
      if (Array.isArray(o.hookErrors)) s.hookErrors += o.hookErrors.length;
      continue;
    }

    if (o.type === 'attachment' && o.attachment && HOOK_ATT.has(o.attachment.type)) {
      const at = o.attachment;
      const k = shortHook(at.command || at.hookName || '?');
      const e = s.att[k] || (s.att[k] = { n: 0, ms: 0, timed: 0, tok: 0, injN: 0, cancel: 0, err: 0 });
      e.n++;
      if (typeof at.durationMs === 'number') { e.ms += at.durationMs; e.timed++; }
      if (at.hookEvent) s.attEvents[at.hookEvent] = (s.attEvents[at.hookEvent] || 0) + 1;
      if (at.type === 'hook_cancelled') e.cancel++;
      if (at.type === 'hook_non_blocking_error') { e.err++; s.hookErrors++; }
      if (at.type === 'hook_success') {
        const t = injectedText(at.stdout);
        if (t) { e.injN++; e.tok += tok(t.length); s.hookCtxCount++; s.hookCtxTok += tok(t.length); }
      }
      continue;
    }

    if (o.type === 'cost-state') {
      // A running session total, so take the highest one rather than summing lines.
      const c = {
        usd: o.totalCostUSD || 0, wall: o.totalDuration || 0, api: o.totalAPIDuration || 0,
        tool: o.totalToolDuration || 0, add: o.totalLinesAdded || 0, del: o.totalLinesRemoved || 0,
        modelUsage: o.modelUsage || null,
      };
      if (!s.cost || c.wall >= s.cost.wall) s.cost = c;
    }
  }

  s.reads = readEv.length;
  s.edits = editEv.length;

  // Rework: the same file edited again within REWORK_WINDOW turns.
  const lastEdit = {};
  const reworkTurns = [];
  for (const e of editEv) {
    const prev = lastEdit[e.p];
    if (prev !== undefined && e.turn - prev <= REWORK_WINDOW) { s.rework++; reworkTurns.push(e.turn); }
    lastEdit[e.p] = e.turn;
  }

  // Re-read: the second and later Read of the same file, counted separately when
  // it crosses a compaction boundary.
  const lastRead = {};
  const rereadTurns = [];
  for (const r of readEv) {
    const prev = lastRead[r.p];
    if (prev !== undefined) {
      s.reread++; rereadTurns.push(r.turn);
      if (s.compacts.some((c) => c.seq > prev.seq && c.seq < r.seq)) s.rereadAcrossCompact++;
    }
    lastRead[r.p] = r;
  }

  // Wasted: after the Read, that file name never appears again.
  s.wasted = countWasted(readEv, mentions);

  // Break the turns down by context-length band.
  const bandAt = (turn) => bandOf(s.ctxByTurn[Math.max(0, turn - 1)] || 0);
  for (let i = 0; i < s.ctxByTurn.length; i++) {
    s.byBand[bandOf(s.ctxByTurn[i])].turns++;
    const p = s.byPos[posOf(i + 1)];
    p.turns++; p.ctx.push(s.ctxByTurn[i]);
  }
  for (const t of trTurns) { s.byBand[bandAt(t)].tr++; s.byPos[posOf(t)].tr++; }
  for (const t of errTurns) { s.byBand[bandAt(t)].err++; s.byPos[posOf(t)].err++; }
  for (const t of rereadTurns) { s.byBand[bandAt(t)].reread++; s.byPos[posOf(t)].reread++; }
  for (const t of reworkTurns) { s.byBand[bandAt(t)].rework++; s.byPos[posOf(t)].rework++; }
  for (const d of s.durations) {
    s.byBand[bandAt(d.turn)].dur.push(d.ms);
    s.byPos[posOf(d.turn)].dur.push(d.ms);
  }

  return s;
}

function countWasted(readEv, mentions) {
  const names = [...new Set(readEv.map((r) => baseName(r.p)).filter(Boolean))].slice(0, 200);
  if (!names.length) return 0;
  const re = new RegExp(names.map(escRe).join('|'), 'g');
  const seen = {};
  for (const m of mentions) {
    if (!m.text) continue;
    re.lastIndex = 0;
    let hit;
    while ((hit = re.exec(m.text)) !== null) (seen[hit[0]] || (seen[hit[0]] = [])).push(m.turn);
  }
  let wasted = 0;
  for (const r of readEv) {
    const at = seen[baseName(r.p)];
    if (!at?.some((turn) => turn > r.turn)) wasted++;
  }
  return wasted;
}

export function mergeQuality(list) {
  const a = {
    sessions: 0, turns: 0, humanTurns: 0, turnDurationSessions: 0,
    ctx: [], effort: {}, days: {},
    toolResults: 0, toolErrors: 0, userPrompts: 0, corrections: 0,
    reads: 0, reread: 0, rereadAcrossCompact: 0, wasted: 0, edits: 0, rework: 0,
    denials: 0, interrupts: 0, durations: [], compacts: [],
    hooks: {}, att: {}, attEvents: {}, hookCtxTok: 0, hookCtxCount: 0, hookErrors: 0,
    usd: 0, wall: 0, api: 0, tool: 0, add: 0, del: 0, costSessions: 0,
    byBand: emptyBands(), byPos: emptyPos(), rates: [],
  };
  const SUM = ['turns', 'humanTurns', 'toolResults', 'toolErrors', 'userPrompts', 'corrections',
    'reads', 'reread', 'rereadAcrossCompact', 'wasted', 'edits', 'rework', 'denials', 'interrupts',
    'hookCtxTok', 'hookCtxCount', 'hookErrors'];
  for (const s of list) {
    if (!s.turns) continue;
    a.sessions++;
    for (const k of SUM) a[k] += s[k];
    if (s.hasTurnDuration) a.turnDurationSessions++;
    for (const c of s.ctxByTurn) a.ctx.push(c);
    for (const [k, v] of Object.entries(s.effort)) a.effort[k] = (a.effort[k] || 0) + v;
    for (const d of s.durations) a.durations.push(d.ms);
    for (const c of s.compacts) a.compacts.push(c);
    for (const [k, v] of Object.entries(s.att)) {
      const e = a.att[k] || (a.att[k] = { n: 0, ms: 0, timed: 0, tok: 0, injN: 0, cancel: 0, err: 0 });
      for (const f of ['n', 'ms', 'timed', 'tok', 'injN', 'cancel', 'err']) e[f] += v[f];
    }
    for (const [k, v] of Object.entries(s.attEvents)) a.attEvents[k] = (a.attEvents[k] || 0) + v;
    for (const [k, v] of Object.entries(s.hooks)) {
      const e = a.hooks[k] || (a.hooks[k] = { n: 0, ms: 0, timed: 0 });
      e.n += v.n; e.ms += v.ms; e.timed += v.timed;
    }
    for (const [d, v] of Object.entries(s.days)) {
      const day = a.days[d] || (a.days[d] = { turns: 0, read: 0, write: 0, in: 0, out: 0, usd: 0 });
      day.turns += v.turns; day.read += v.read; day.write += v.write; day.in += v.in; day.out += v.out;
    }
    for (let i = 0; i < BANDS.length; i++) {
      const x = a.byBand[i], y = s.byBand[i];
      x.turns += y.turns; x.tr += y.tr; x.err += y.err; x.reread += y.reread; x.rework += y.rework;
      for (const d of y.dur) x.dur.push(d);
    }
    for (let i = 0; i < POS.length; i++) {
      const x = a.byPos[i], y = s.byPos[i];
      x.turns += y.turns; x.tr += y.tr; x.err += y.err;
      x.reread += y.reread; x.rework += y.rework;
      for (const c of y.ctx) x.ctx.push(c);
      for (const d of y.dur) x.dur.push(d);
    }
    if (s.cost) {
      a.costSessions++;
      a.usd += s.cost.usd; a.wall += s.cost.wall; a.api += s.cost.api; a.tool += s.cost.tool;
      a.add += s.cost.add; a.del += s.cost.del;
      const r = sessionRate(s);
      if (r) a.rates.push(r);
    }
  }
  return a;
}

/**
 * Derive the price of one input-equivalent token from the real bill.
 * cost-state's costUSD is measured, not estimated, so this doubles as a check on
 * whether the weights W are anywhere near right.
 */
export function sessionRate(s) {
  const mu = s.cost?.modelUsage;
  if (!mu) return null;
  let eq = 0, usd = 0;
  for (const m of Object.values(mu)) {
    eq += (m.inputTokens || 0) * W.in + (m.cacheCreationInputTokens || 0) * W.write
      + (m.cacheReadInputTokens || 0) * W.read + (m.outputTokens || 0) * W.out;
    usd += m.costUSD || 0;
  }
  if (eq <= 0 || usd <= 0) return null;
  return { eq, usd, rate: usd / eq };
}

const med = (arr) => { const c = [...arr].sort((x, y) => x - y); return c.length ? c[Math.floor(c.length * 0.5)] : 0; };
const p90v = (arr) => { const c = [...arr].sort((x, y) => x - y); return c.length ? c[Math.floor(c.length * 0.9)] : 0; };
const qrate = (n, d) => (d ? (100 * n / d).toFixed(1) + '%' : '—');
const secs = (ms) => (ms / 1000).toFixed(1) + 's';
const dollars = (v) => '$' + v.toFixed(2);

function scanQuality(days) {
  const out = [];
  for (const { path: p } of sessionFiles(days)) {
    let lines;
    try { lines = fs.readFileSync(p, 'utf8').split('\n'); } catch { continue; }
    const recs = [];
    for (const ln of lines) {
      if (!ln.trim()) continue;
      try { recs.push(JSON.parse(ln)); } catch { /* 壊れた行は捨てる */ }
    }
    out.push(analyzeSession(recs));
  }
  return mergeQuality(out);
}

/* ── verdict: fuel, intelligence and speed against the baseline, together ──
   All three have to hold. Spend down but quality down is a failure; quality held
   but everything slower is also a failure. So they are read side by side, once. */
const QBASE = path.join(STATE_DIR, 'nenpi-quality-baseline.json');
const NOISE = 5;   // a smaller relative change than this reads as "unchanged"

// The real dollar figure only exists for about one session in fifteen, so the
// fuel row uses context re-sent per turn, which every session has and which the
// bill is proportional to.
export function fuel(j) {
  let read = 0, turns = 0;
  for (const v of Object.values(j.days_ || {})) { read += v.cacheRead || 0; turns += v.turns || 0; }
  const perTurn = read / (turns || 1);
  return { read, turns, perTurn, usdPerTurn: perTurn * 1.5 / 1e6 };
}

// [group, [english, japanese], accessor, unit]. Groups and directions are stable codes so
// that the logic below and the tests never depend on the display language.
export const VROWS = [
  ['fuel',  ['context re-sent per turn', '1ターンの文脈再送'], (j) => fuel(j).perTurn, 'tok'],
  ['intel', ['tool failure rate', 'ツール失敗率'], (j) => j.quality.toolErrorRate, '%'],
  ['intel', ['rework rate', '手戻り率'], (j) => j.quality.reworkRate, '%'],
  ['intel', ['user correction rate', 'ユーザー訂正率'], (j) => j.quality.correctionRate, '%'],
  ['intel', ['wasted Read rate', '空振りRead率'], (j) => j.quality.wastedReadRate, '%'],
  ['intel', ['turns per prompt', '1発言あたりターン数'], (j) => j.quality.turnsPerPrompt, ''],
  ['speed', ['wall time per turn', '1ターンの実時間'], (j) => j.speed.turnMedianMs / 1000, 's'],
];

export const GROUP_LABEL = { fuel: ['fuel', '燃費'], intel: ['intel', '知能'], speed: ['speed', '速度'] };
export const DIR_LABEL = {
  nobase: ['no baseline', '基準なし'], flat: ['unchanged', '変化なし'],
  better: ['better', '改善'], worse: ['worse', '悪化'],
};

export function verdict(base, now) {
  const rows = VROWS.map(([group, label, get, unit]) => {
    let b = 0, v = 0;
    try { b = get(base); } catch { b = 0; }
    try { v = get(now); } catch { v = 0; }
    const d = b ? 100 * (v - b) / b : 0;
    const dir = !b ? 'nobase' : Math.abs(d) < NOISE ? 'flat' : (d < 0 ? 'better' : 'worse');
    return { group, label, b, v, d, dir, unit };
  });
  const worse = rows.filter((r) => r.group !== 'fuel' && r.dir === 'worse');
  const f = rows[0];
  let sayCode, say;
  if (worse.length) {
    sayCode = 'tradeoff';
    const names = worse.map((r) => t(...r.label)).join(t(', ', '・'));
    say = t('WARNING: the fuel saving is being bought with intelligence or speed (' + names
        + '). Consider backing the change out.',
      '⚠ 賢さか速さを削って燃費を買っている（' + names + '）。入れた仕掛けの撤退を検討する。');
  } else if (f.dir === 'better') {
    sayCode = 'ontarget';
    say = t('On target. Fuel use fell and neither intelligence nor speed moved.',
      '狙いどおり。燃費だけが下がり、賢さと速さは動いていない。');
  } else if (f.dir === 'worse') {
    sayCode = 'worse';
    say = t('Fuel use is getting worse. Either the change is not working, or the way you work changed.',
      '燃費が悪化している。仕掛けが効いていないか、使い方が変わった。');
  } else {
    sayCode = 'flat';
    say = t('No difference yet (everything is within +/-' + NOISE + '%).',
      'まだ差が出ていない（すべて ±' + NOISE + '% 以内）。');
  }
  return { rows, say, sayCode };
}


// CJK characters occupy two columns. padEnd counts code units, so tables that
// mix scripts come out crooked without this.
const WIDE_RE = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/;
const wcw = (t) => Array.from(t).reduce((w, c) => w + (WIDE_RE.test(c) ? 2 : 1), 0);
const padR = (t, w) => t + ' '.repeat(Math.max(0, w - wcw(t)));
const padL = (t, w) => ' '.repeat(Math.max(0, w - wcw(t))) + t;
const vnum = (v, unit) => {
  if (unit === 'tok') return Math.round(v).toLocaleString();
  if (unit === '%') return v.toFixed(1) + '%';
  if (unit === 's') return v.toFixed(1) + 's';
  return v.toFixed(1);
};

function printVerdict(now, days) {
  const base = readState('nenpi-quality-baseline.json');
  if (!base) {
    console.log('## ' + t('Verdict', '判定'));
    console.log('  ' + t('No baseline yet. Freeze the current numbers with `nenpi baseline --days ' + days
      + '` and the next run will show a diff.',
      '基準がまだ無い。`nenpi baseline --days ' + days + '` で今の数字を留めると、次回から差分が出る。'));
    console.log('');
    return;
  }
  const v = verdict(base, now);
  console.log('## ' + t('Verdict', '判定')
    + t(' (baseline: ' + String(base.savedAt || '?').slice(0, 10) + ', last ' + base.days + ' days)',
        '（基準: ' + String(base.savedAt || '?').slice(0, 10) + ' / 直近' + base.days + '日）'));
  if (base.days !== days) console.log('  ' + windowNote(base.days, days));
  console.log('  ' + padR(t('group', '区分'), 7) + padR(t('metric', '指標'), 28) + padL(t('baseline', '基準'), 12)
    + '  →' + padL(t('now', '今'), 12) + padL(t('change', '変化'), 8) + '  ' + t('verdict', '判定'));
  for (const r of v.rows) {
    console.log('  ' + padR(t(...GROUP_LABEL[r.group]), 7) + padR(t(...r.label), 28)
      + padL(vnum(r.b, r.unit), 12) + '  →' + padL(vnum(r.v, r.unit), 12)
      + padL((r.d > 0 ? '+' : '') + r.d.toFixed(0) + '%', 8) + '  ' + t(...DIR_LABEL[r.dir]));
  }
  console.log('  → ' + v.say);
  console.log('');
}

/* ── effect: did the nudges actually do anything? ─────────────────────
   The verdict in `quality` aggregates by day, which confounds: spend went down,
   but was that the hooks or just an easier week? Here the comparison is inside
   one session — turns right after a nudge against ordinary turns — so however
   hard the work was, it applies to both sides and cancels out.

   Each firing survives in the transcript as type:"attachment" / hook_success,
   with the command (which nudge), the stdout (what it said) and a timestamp. */

const NENPI_HOOK = /nenpi\.mjs\\?" hook (pre|prompt|post)/;

// One response is split across lines by thinking / text / tool_use, all sharing a
// message.id. Counting lines pins the bundling rate at 0.0% forever, so regroup by
// requestId first. Each response becomes { t, tools, names, ids, seg }, where seg
// numbers the stretch between two human prompts.
export function foldResponses(lines) {
  const byReq = new Map();
  const fires = [];
  let seg = 0;
  for (const line of lines) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'user') {
      // A user line carrying only tool_result is a tool coming back; anything else
      // is a person speaking, and starts a new stretch (meta lines included).
      const c = o.message?.content;
      const isResult = Array.isArray(c) && c.length > 0 && c.every((b) => b.type === 'tool_result');
      if (!isResult) seg++;
      continue;
    }
    if (o.type === 'assistant') {
      const m = o.message;
      if (!m) continue;
      const key = o.requestId || m.id;
      if (!key) continue;
      const uses = (m.content || []).filter((b) => b.type === 'tool_use');
      let cur = byReq.get(key);
      if (!cur) byReq.set(key, (cur = { t: Date.parse(o.timestamp || 0), tools: 0, names: [], ids: [], seg }));
      cur.tools += uses.length;
      for (const u of uses) { cur.names.push(u.name); cur.ids.push(u.id); }
      continue;
    }
    if (o.type !== 'attachment') continue;
    const a = o.attachment || {};
    if (a.type !== 'hook_success') continue;
    const mm = NENPI_HOOK.exec(String(a.command || ''));
    if (!mm) continue;
    fires.push({ kind: mm[1], t: Date.parse(o.timestamp || 0), out: String(a.stdout || '') });
  }
  return { turns: [...byReq.values()].sort((a, b) => a.t - b.t), fires };
}

export function scanEffect(days) {
  const r = {
    post: { fired: 0, afterBundled: 0, afterTotal: 0, baseBundled: 0, baseTotal: 0 },
    pre: { fired: 0, files: [] },
    prompt: { fired: 0, turnsLeft: [] },
    sessions: 0,
  };
  for (const f of sessionFiles(days)) {
    let lines; try { lines = fs.readFileSync(f.path, 'utf8').split(NL_CH); } catch { continue; }
    // Lay this session's responses out in order, deduplicated by message.id.
    const { turns, fires } = foldResponses(lines);
    if (!fires.length) continue;
    r.sessions++;

    // Mark the turns right after a nudge, and keep them out of the baseline set.
    const marked = new Set();
    for (const fire of fires) {
      if (fire.kind === 'pre') {
        if (!fire.out.includes('updatedInput')) continue;   // it did not cut anything
        r.pre.fired++;
        const fp = /"file_path":"((?:[^"\\]|\\.)*)"/.exec(fire.out);
        if (fp) r.pre.files.push(fp[1].replace(/\\\\/g, '\\'));
        continue;
      }
      if (fire.kind === 'prompt') {
        if (!fire.out.includes('[nenpi]')) continue;
        r.prompt.fired++;
        r.prompt.turnsLeft.push(turns.filter((x) => x.t > fire.t).length);
        continue;
      }
      // post: right after "bundle them", was the next turn actually bundled?
      if (!fire.out.includes('[nenpi]')) continue;
      r.post.fired++;
      const i = turns.findIndex((x) => x.t > fire.t && x.tools > 0);
      if (i < 0) continue;
      marked.add(i);
      r.post.afterTotal++;
      if (turns[i].tools >= 2) r.post.afterBundled++;
    }
    // The baseline: tool turns in the same session that no nudge preceded.
    for (let i = 0; i < turns.length; i++) {
      if (marked.has(i) || turns[i].tools === 0) continue;
      r.post.baseTotal++;
      if (turns[i].tools >= 2) r.post.baseBundled++;
    }
  }
  return r;
}

// ---------------------------------------------------------------------------
// errors — where tool failures actually come from. The tool failure rate in
// `quality` also rises on environmental causes (auto mode denials, EPERM, a human
// pressing stop), so those are separated from model-caused ones. The model x effort
// columns exist so a change of effort can be cut in half with --split and compared.
// ---------------------------------------------------------------------------
export const ENV_ERROR_WORDS = [
  'denied by the Claude Code auto mode',   // the auto mode classifier stopped it
  'Permission to use ',                    // permission refused (a deny rule, or the prompt declined)
  'The user doesn.t want to proceed',      // a person stopped it (the apostrophe is matched as .)
  'EPERM: operation not permitted',        // this machine blocks some spawns (uv_spawn)
  'lost focus: refusing to type',          // the GUI under test was not in the foreground
  'Multiple Chrome browsers are connected',// the extension has no browser selected
];
export const ENV_ERROR_RE = new RegExp(ENV_ERROR_WORDS.join('|'));
export const classifyError = (text) => (ENV_ERROR_RE.test(text || '') ? 'env' : 'model');
export const resultText = (b) => (typeof b.content === 'string' ? b.content
  : Array.isArray(b.content) ? b.content.map((x) => x.text || '').join(' ') : '');

export const emptyErrors = () => ({ sessions: 0, results: 0, errors: 0, env: 0, byModelEffort: {}, byTool: {}, texts: {} });

// Fold one session's lines into acc. Each tool_result is tied back to the response
// that issued it via tool_use_id, and attributed to that response's model / effort.
// opts.since / until (ms) narrow the window by tool_result timestamp.
export function tallyErrors(lines, acc, opts = {}) {
  const uses = new Map();
  for (const line of lines) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    const c = o.message?.content;
    if (!Array.isArray(c)) continue;
    if (o.type === 'assistant') {
      const model = String(o.message?.model || '?').replace(/^claude-/, '');
      const effort = o.effort || '?';
      for (const b of c) if (b.type === 'tool_use') uses.set(b.id, { name: b.name || '?', model, effort });
      continue;
    }
    if (o.type !== 'user') continue;
    const ts = Date.parse(o.timestamp || '') || 0;
    if (opts.since && ts && ts < opts.since) continue;
    if (opts.until && ts && ts >= opts.until) continue;
    for (const b of c) {
      if (b.type !== 'tool_result') continue;
      const u = uses.get(b.tool_use_id) || { name: '?', model: '?', effort: '?' };
      const me = acc.byModelEffort[u.model + '|' + u.effort] || (acc.byModelEffort[u.model + '|' + u.effort] = { n: 0, e: 0, env: 0 });
      const bt = acc.byTool[u.name] || (acc.byTool[u.name] = { n: 0, e: 0, env: 0 });
      acc.results++; me.n++; bt.n++;
      if (!b.is_error) continue;
      const txt = resultText(b);
      acc.errors++; me.e++; bt.e++;
      if (classifyError(txt) === 'env') { acc.env++; me.env++; bt.env++; }
      const head = txt.replace(/\s+/g, ' ').slice(0, 70);
      acc.texts[head] = (acc.texts[head] || 0) + 1;
    }
  }
  return acc;
}

export function scanErrors(days, opts = {}) {
  const acc = emptyErrors();
  for (const f of sessionFiles(days)) {
    let lines; try { lines = fs.readFileSync(f.path, 'utf8').split(NL_CH); } catch { continue; }
    acc.sessions++;
    tallyErrors(lines, acc, opts);
  }
  return acc;
}

// The shape for a collector: totals only, never the text of an error.
export function errorsJson(a) {
  return {
    toolResults: a.results, toolErrors: a.errors, toolErrorsEnv: a.env,
    toolErrorRate: +(100 * a.errors / (a.results || 1)).toFixed(1),
    byModelEffort: a.byModelEffort,
  };
}

function printErrorTable(a, title) {
  const r = (e, n) => (100 * e / (n || 1)).toFixed(1) + '%';
  console.log('## ' + title + '  tool_result ' + a.results.toLocaleString()
    + t(' / failed ', ' / 失敗 ') + a.errors + ' (' + r(a.errors, a.results) + ')'
    + t('  of which environment ', '  うち環境起因 ') + a.env + t(' / model ', ' / モデル起因 ')
    + (a.errors - a.env) + ' (' + r(a.errors - a.env, a.results) + ')');
  console.log('  ' + padR(t('model|effort', 'モデル|effort'), 26) + padL(t('calls', '呼び'), 7)
    + padL(t('fail', '失敗'), 6) + padL(t('rate', '率'), 8) + padL(t('env', '環境'), 6)
    + padL(t('model', 'モデル'), 6) + padL(t('model %', 'モデル率'), 9));
  for (const k of Object.keys(a.byModelEffort).sort()) {
    const v = a.byModelEffort[k];
    console.log('  ' + k.padEnd(26) + String(v.n).padStart(7) + String(v.e).padStart(6) + r(v.e, v.n).padStart(8)
      + String(v.env).padStart(6) + String(v.e - v.env).padStart(6) + r(v.e - v.env, v.n).padStart(9));
  }
}

function errors(days, asJson, splitArg) {
  const split = splitArg ? Date.parse(splitArg) : NaN;
  if (splitArg && Number.isNaN(split)) {
    console.log(t('--split: cannot parse the timestamp: ', '--split の日時が読めない: ') + splitArg
      + t(' (example: 2026-09-03T16:00, in local time)', '（例: 2026-09-03T16:00 ＝ローカル時刻）'));
    process.exit(1);
  }
  if (asJson) { console.log(JSON.stringify(errorsJson(scanErrors(days)), null, 2)); return; }
  const a = scanErrors(days);
  console.log('# nenpi errors — ' + t('last ' + days + (days === 1 ? ' day' : ' days') + ' / ' + a.sessions + ' sessions',
    '直近' + days + '日 / ' + a.sessions + 'セッション'));
  console.log('');
  if (!Number.isNaN(split)) {
    printErrorTable(scanErrors(days, { until: split }), t('before (up to ' + splitArg + ')', '切り前（〜' + splitArg + '）'));
    console.log('');
    printErrorTable(scanErrors(days, { since: split }), t('after (' + splitArg + ' onward)', '切り後（' + splitArg + '〜）'));
  } else {
    printErrorTable(a, t('all', '全体'));
  }
  console.log('');
  const r = (e, n) => (100 * e / (n || 1)).toFixed(1) + '%';
  console.log('## ' + t('By tool (most failures first)', 'ツール別（失敗の多い順）'));
  Object.entries(a.byTool).filter(([, v]) => v.e).sort((x, y) => y[1].e - x[1].e).slice(0, 10)
    .forEach(([k, v]) => { console.log('  ' + k.padEnd(40) + String(v.e).padStart(5) + ' /' + String(v.n).padStart(6) + r(v.e, v.n).padStart(8)
      + t('   env ', '   環境 ') + v.env + t(' / model ', ' / モデル ') + (v.e - v.env)); });
  console.log('');
  console.log('## ' + t('First line of each error (stays on this machine; --json never includes it)',
    'エラー文の先頭（このPCだけで見る。収集役には送らない）'));
  Object.entries(a.texts).sort((x, y) => y[1] - x[1]).slice(0, 12)
    .forEach(([k, v]) => { console.log('  ' + String(v).padStart(4) + '  ' + k); });
  const envShare = a.errors ? 100 * a.env / a.errors : 0;
  console.log('');
  if (envShare >= 30) console.log('→ ' + t(
    envShare.toFixed(0) + '% of the failures come from the environment. A rising tool failure rate in '
      + '`quality` is therefore not evidence that the model got worse.',
    '失敗の ' + envShare.toFixed(0) + '% は環境起因。quality のツール失敗率が上がっていても、モデルの頭が悪くなったとは言えない。'));
  else console.log('→ ' + t(
    'Only ' + envShare.toFixed(0) + '% come from the environment; most failures are the model'
      + ' (paths that do not exist, malformed commands).',
    '環境起因は ' + envShare.toFixed(0) + '%。失敗の大半はモデル側（存在しないパス・壊れたコマンド）。'));
}

function effect(days) {
  const r = scanEffect(days);
  console.log('# nenpi effect — ' + t('last ' + days + (days === 1 ? ' day' : ' days') + ' / ' + r.sessions + ' sessions where a nudge fired',
    '直近' + days + '日 / 口出しが出た ' + r.sessions + ' セッション'));
  console.log('');
  if (!r.sessions) {
    console.log('  ' + t('The hooks have never fired. Check that they are registered in settings.json.',
      'まだ一度も発火していない。settings.json に登録されているか確かめること。'));
    console.log('');
    return;
  }

  console.log('## ' + t('"bundle them" (hook post) — did the next turn actually bundle?',
    '束ねろ（hook post）——直後に本当に束ねたか'));
  console.log('  ' + padR(t('fired', '発火'), 30) + String(r.post.fired).padStart(6) + t(' times', ' 回'));
  if (r.post.afterTotal) {
    const af = 100 * r.post.afterBundled / r.post.afterTotal;
    const ba = r.post.baseTotal ? 100 * r.post.baseBundled / r.post.baseTotal : 0;
    console.log('  ' + padR(t('bundled on the next turn', '直後のターンで束ねた'), 30)
      + String(r.post.afterBundled).padStart(6) + ' / ' + r.post.afterTotal + '   ' + af.toFixed(1) + '%');
    console.log('  ' + padR(t('normal turns, same sessions', '同じセッションの平常時'), 30)
      + String(r.post.baseBundled).padStart(6) + ' / ' + r.post.baseTotal + '   ' + ba.toFixed(1) + '%');
    const d = af - ba;
    console.log('  ' + padR(t('difference', '差'), 30) + ((d >= 0 ? '+' : '') + d.toFixed(1) + 'pt').padStart(6));
    console.log('  → ' + (r.post.afterTotal < 10
      ? t('Too few firings to judge yet (10 or more would do).', 'まだ発火が少なすぎて判断できない（10回以上欲しい）。')
      : d > 10 ? t('It works. The bundling rate rises only right after the nudge.',
                   '効いている。口出しの直後だけ束ね率が上がっている。')
      : t('It does not work. Reword it, or take it out.', '効いていない。言い方を変えるか、外す。')));
  }
  console.log('');

  console.log('## ' + t('large files (hook pre) — how often a full-file Read was cut at the door',
    '大きいファイル（hook pre）——全文Readを入口で切った回数'));
  console.log('  ' + padR(t('cut', '切った'), 30) + String(r.pre.fired).padStart(6)
    + t(' times (this one is enforced, not suggested, so firing is the effect)',
        ' 回（これは提案ではなく強制なので、発火＝効果）'));
  const seenF = {};
  for (const p of r.pre.files) seenF[p] = (seenF[p] || 0) + 1;
  const top = Object.entries(seenF).sort((a, b) => b[1] - a[1]).slice(0, 5);
  for (const [p, c] of top) console.log('    ' + String(c).padStart(3) + t(' x  ', ' 回  ') + p);
  console.log('');

  console.log('## ' + t('the price of the context (hook prompt) — did the session end after it?',
    '文脈の値段（hook prompt）——出したあとセッションが終わったか'));
  console.log('  ' + padR(t('fired', '発火'), 30) + String(r.prompt.fired).padStart(6) + t(' times', ' 回'));
  if (r.prompt.turnsLeft.length) {
    const a = r.prompt.turnsLeft.slice().sort((x, y) => x - y);
    const m = a[Math.floor(a.length / 2)];
    console.log('  ' + padR(t('turns that followed', 'その後続いたターン数'), 30)
      + t('median ', '中央値 ') + m + t(' (a short tail means the session was cleared)', '（短ければ /clear したということ）'));
  }
  console.log('');
}

function quality(days, asJson) {
  const a = scanQuality(days);
  if (!a.turns) { console.log(t('no sessions in this window', '対象セッションなし')); return; }

  const eqTot = a.rates.reduce((x, r) => x + r.eq, 0);
  const usdTot = a.rates.reduce((x, r) => x + r.usd, 0);
  const rateUsd = eqTot ? usdTot / eqTot : 0;
  const resid = usdTot ? 100 * a.rates.reduce((x, r) => x + Math.abs(r.eq * rateUsd - r.usd), 0) / usdTot : 0;
  for (const v of Object.values(a.days)) {
    v.usd = (v.in * W.in + v.write * W.write + v.read * W.read + v.out * W.out) * rateUsd;
  }

  if (asJson) { console.log(JSON.stringify(summaryJson(a, days), null, 2)); return; }

  console.log('# nenpi quality — ' + t(
    'last ' + days + (days === 1 ? ' day' : ' days') + ' / ' + a.sessions + ' sessions / ' + a.turns.toLocaleString() + ' turns',
    '直近' + days + '日 / ' + a.sessions + 'セッション / ' + a.turns.toLocaleString() + 'ターン'));
  console.log('');
  printVerdict(summaryJson(a, days), days);

  const estTot = Object.values(a.days).reduce((x, v) => x + v.usd, 0);
  console.log('## ' + t('Fuel gauge', '燃費計'));
  console.log('  ' + padR(t('measured cost-state total', '実測 cost-state 合計'), 28) + dollars(a.usd).padStart(11)
    + t('   recorded in only ', '   記録があるのは ') + a.costSessions + '/' + a.sessions
    + t(' sessions', ' セッションのみ'));
  if (a.rates.length) {
    console.log('  ' + padR(t('unit price derived from it', 'そこから出した単価'), 28)
      + (rateUsd * 1e6).toFixed(2).padStart(11) + t(' $/1M input-equivalent tok', ' $/入力換算1Mtok')
      + t('   calibration residual ', '   較正残差 ') + resid.toFixed(1) + '% '
      + (resid < 5 ? t('(the weights W agree with the real bill)', '（重み W は実額と整合）')
                   : t('WARNING: the weights W do not match reality', '🔴 重み W が実態と合っていない')));
    console.log('  ' + padR(t('estimate for all ' + a.sessions + ' sessions', '全' + a.sessions + 'セッション推計'), 28)
      + dollars(estTot).padStart(11)
      + t('   <- measured unit price x usage across every turn, summed by day.',
          '   ← 実測単価 × 全ターンの usage。日別の合計。'));
  }
  console.log('  ' + t('by day (estimated)', '日別（推計）'));
  for (const d of Object.keys(a.days).sort()) {
    const v = a.days[d];
    console.log('    ' + d + '  ' + dollars(v.usd).padStart(9) + t('  turns ', '  ターン ') + String(v.turns).padStart(5)
      + t('  per turn ', '  1ターン ') + ('$' + (v.usd / (v.turns || 1)).toFixed(3)).padStart(8)
      + '  cache_read ' + M(v.read).padStart(7));
  }
  console.log('');

  console.log('## ' + t('Intelligence gauge', '知能計'));
  const humanN = a.userPrompts || a.humanTurns;
  const row = (label, val, note) => console.log('  ' + padR(label, 30) + String(val).padStart(10) + '   ' + note);
  row(t('rework rate', '手戻り率'), qrate(a.rework, a.edits),
    t('re-edited ' + a.rework + ' / edits ' + a.edits + ' (within ' + REWORK_WINDOW + ' turns)',
      '再編集 ' + a.rework + ' / 編集 ' + a.edits + '（' + REWORK_WINDOW + 'ターン以内）'));
  row(t('tool failure rate', 'ツール失敗率'), qrate(a.toolErrors, a.toolResults),
    'is_error ' + a.toolErrors + ' / tool_result ' + a.toolResults);
  row(t('user correction rate', 'ユーザー訂正率'), qrate(a.corrections, a.userPrompts),
    t('corrections ' + a.corrections + ' / prompts ' + a.userPrompts,
      '訂正 ' + a.corrections + ' / 発言 ' + a.userPrompts));
  row(t('wasted Read rate', '空振りRead率'), qrate(a.wasted, a.reads),
    t('never used ' + a.wasted + ' / Read ' + a.reads, '未使用 ' + a.wasted + ' / Read ' + a.reads));
  row(t('re-read rate', '再読み率'), qrate(a.reread, a.reads),
    t('re-read ' + a.reread + ' / Read ' + a.reads, '再読み ' + a.reread + ' / Read ' + a.reads));
  row(t('  of which across a compact', '  うち compact をまたいだ'), qrate(a.rereadAcrossCompact, a.reads),
    t(a.rereadAcrossCompact + ' <- dropped by compaction and read again',
      a.rereadAcrossCompact + ' 件 ← 圧縮が捨てて読み直した分'));
  row(t('interruption rate', '中断率'), (100 * (a.denials + a.interrupts) / (a.turns || 1)).toFixed(1) + '/100T',
    t('denied ' + a.denials + ' + interrupted ' + a.interrupts, '拒否 ' + a.denials + ' + 中断 ' + a.interrupts));
  row(t('turns per prompt', '1発言あたりのターン数'), (a.turns / (humanN || 1)).toFixed(1),
    t('assistant ' + a.turns.toLocaleString() + ' / human prompts ' + humanN,
      'アシスタント ' + a.turns.toLocaleString() + ' / 人間の発言 ' + humanN));
  row(t('lines added/removed', '行の増減'), '+' + a.add + '/-' + a.del,
    t('measured from cost-state', 'cost-state 実測'));
  console.log('  ' + t('correction words: ', '訂正語: ') + CORRECTION_WORDS.join(' '));
  console.log('');

  console.log('## ' + t('Speed gauge', '速度計'));
  if (a.durations.length) {
    console.log('  ' + padR(t('wall time per prompt', '1発言の実時間'), 22) + t('median ', '中央値 ')
      + secs(med(a.durations)).padStart(9) + ' / p90 ' + secs(p90v(a.durations)).padStart(9)
      + t('   turn_duration, ' + a.durations.length + ' samples', '   turn_duration 実測 ' + a.durations.length + '件')
      + t(' (recorded in ' + a.turnDurationSessions + '/' + a.sessions + ' sessions)',
          '（記録があるのは ' + a.turnDurationSessions + '/' + a.sessions + ' セッション）'));
  } else {
    console.log('  ' + padR(t('wall time per prompt', '1発言の実時間'), 22)
      + t('no turn_duration recorded (the sessions in this window predate it)',
          'turn_duration の記録なし（この窓のセッションは古い）'));
  }
  if (a.wall) {
    const other = Math.max(0, a.wall - a.api - a.tool);
    console.log('  ' + t('split (' + (a.wall / 3.6e6).toFixed(1) + 'h total)  inference ',
                         '内訳（累計 ' + (a.wall / 3.6e6).toFixed(1) + '時間）  推論 ') + qrate(a.api, a.wall)
      + t(' / tools ', ' / ツール ') + qrate(a.tool, a.wall)
      + t(' / other (waiting for a human, etc.) ', ' / その他（人の入力待ち等） ') + qrate(other, a.wall));
  }
  console.log('');

  console.log('## ' + t('Correlation — context length band x metric', '相関表 — 文脈長帯 × 指標'));
  console.log('    ' + padR(t('band', '帯'), 11) + padL(t('turns', 'ターン'), 7) + padL(t('tool fail', 'ツール失敗'), 11)
    + padL(t('re-read', '再読み'), 9) + padL(t('rework', '手戻り'), 9) + padL(t('wall/prompt', '1発言の実時間'), 15));
  for (let i = 0; i < BANDS.length; i++) {
    const b = a.byBand[i];
    if (!b.turns) continue;
    console.log('    ' + bandLabel(i).padEnd(11) + String(b.turns).padStart(7)
      + qrate(b.err, b.tr).padStart(11) + qrate(b.reread, b.turns).padStart(9)
      + qrate(b.rework, b.turns).padStart(9)
      + (b.dur.length ? secs(med(b.dur)) : '—').padStart(15));
  }
  console.log('');

  console.log('## ' + t('Checking for confounding — turn position x tool failure',
    '交絡の確認 — ターン位置 × ツール失敗'));
  console.log('    ' + padR(t('position', '位置'), 11) + padL(t('turns', 'ターン'), 7) + padL(t('median ctx', '文脈中央値'), 13)
    + padL(t('tool fail', 'ツール失敗'), 12) + padL(t('re-read', '再読み'), 9) + padL(t('rework', '手戻り'), 9)
    + padL(t('wall/prompt', '1発言の実時間'), 15));
  for (let i = 0; i < POS.length; i++) {
    const p = a.byPos[i];
    if (!p.turns) continue;
    console.log('    ' + posLabel(i).padEnd(11) + String(p.turns).padStart(7)
      + med(p.ctx).toLocaleString().padStart(13) + qrate(p.err, p.tr).padStart(12)
      + qrate(p.reread, p.turns).padStart(9) + qrate(p.rework, p.turns).padStart(9)
      + (p.dur.length ? secs(med(p.dur)) : '—').padStart(15));
  }
  console.log('  ' + t('note: context length and turn position are easily the same axis under two names.',
    '※ 文脈長帯とターン位置は同じ軸を別の名前で見ているだけになりやすい。'));
  console.log('  ' + t('      If a metric still moves once stratified by position, it is a context-length effect;'
    + ' if it flattens, it was position all along.',
    '     位置で層別しても指標が動くなら文脈長の効果、動かないなら位置の効果。'));
  console.log('');

  console.log('## ' + t('Compaction', '圧縮（compact）'));
  if (a.compacts.length) {
    const trig = {};
    for (const c of a.compacts) trig[c.trigger] = (trig[c.trigger] || 0) + 1;
    const pre = Math.round(a.compacts.reduce((x, c) => x + c.pre, 0) / a.compacts.length);
    const post = Math.round(a.compacts.reduce((x, c) => x + c.post, 0) / a.compacts.length);
    console.log('  ' + t('happened ', '発生 ') + a.compacts.length + t(' times   average ', ' 回   平均 ')
      + pre.toLocaleString() + ' → ' + post.toLocaleString()
      + t(' tok   dropped in total ', ' tok   捨てた累計 ')
      + a.compacts.reduce((x, c) => x + c.dropped, 0).toLocaleString() + ' tok');
    console.log('  ' + t('trigger ', 'トリガ ') + Object.entries(trig).map(([k, v]) => k + ' ' + v).join(' / '));
  } else {
    console.log('  ' + t('nothing recorded', '記録なし'));
  }
  console.log('');

  console.log('## ' + t('Attribution (your own hooks)', '帰属（自分のフック）'));
  const ats = Object.entries(a.att).sort((x, y) => (y[1].tok - x[1].tok) || (y[1].ms - x[1].ms));
  if (ats.length) {
    console.log('  ' + padL(t('calls', '回数'), 6) + padL(t('total ms', '合計ms'), 10) + padL(t('avg ms', '平均ms'), 9)
      + padL(t('inj tok', '注入tok'), 11) + padL(t('inj n', '注入回'), 7) + padL(t('canc', '打切'), 6)
      + padL(t('fail', '失敗'), 6) + '  ' + t('hook', 'フック'));
    for (const [k, v] of ats.slice(0, 15)) {
      console.log('  ' + String(v.n).padStart(6) + String(v.ms).padStart(10)
        + String(v.timed ? Math.round(v.ms / v.timed) : 0).padStart(9)
        + v.tok.toLocaleString().padStart(11) + String(v.injN).padStart(7)
        + String(v.cancel).padStart(6) + String(v.err).padStart(6) + '  ' + k);
    }
    console.log('  ' + padR(t('by event', 'イベント別'), 16) + Object.entries(a.attEvents).sort((x, y) => y[1] - x[1])
      .map(([k, v]) => k + ' ' + v).join(' / '));
    console.log('  ' + padR(t('injected total', '注入合計'), 16) + a.hookCtxTok.toLocaleString() + ' tok / '
      + a.hookCtxCount + t(' times', ' 回')
      + t(' (' + (a.hookCtxTok / (a.turns || 1)).toFixed(1) + ' tok per turn; whatever stays in the context is re-sent every turn)',
          '（1ターンあたり ' + (a.hookCtxTok / (a.turns || 1)).toFixed(1) + ' tok。文脈に残る分は毎ターン再送される）'));
  } else {
    console.log('  ' + t('no hook_* attachments recorded', 'attachment の hook_* 記録なし'));
  }
  const hs = Object.entries(a.hooks).sort((x, y) => y[1].ms - x[1].ms);
  if (hs.length) {
    console.log('  ' + t('only present in the Stop hook summary (hookInfos) — duration only',
      'Stop フック要約（hookInfos）にしか残っていない分 — 所要時間のみ'));
    for (const [k, v] of hs.slice(0, 10)) {
      console.log('  ' + String(v.n).padStart(6) + (v.timed ? String(v.ms).padStart(10)
        + String(Math.round(v.ms / v.timed)).padStart(9) : padL(t('not timed', '計測なし'), 19)) + '  ' + k);
    }
  }
  console.log('');

  console.log('## effort');
  console.log('  ' + (Object.entries(a.effort).map(([k, v]) => k + ' ' + v + t(' turns', 'ターン')).join(' / ')
    || t('nothing recorded', '記録なし')));
}

export function summaryJson(a, days) {
  const humanN = a.userPrompts || a.humanTurns;
  return {
    days, sessions: a.sessions, turns: a.turns, usd: a.usd,
    quality: {
      reworkRate: 100 * a.rework / (a.edits || 1),
      toolErrorRate: 100 * a.toolErrors / (a.toolResults || 1),
      correctionRate: 100 * a.corrections / (a.userPrompts || 1),
      wastedReadRate: 100 * a.wasted / (a.reads || 1),
      rereadRate: 100 * a.reread / (a.reads || 1),
      rereadAcrossCompactRate: 100 * a.rereadAcrossCompact / (a.reads || 1),
      interruptPer100Turns: 100 * (a.denials + a.interrupts) / (a.turns || 1),
      turnsPerPrompt: a.turns / (humanN || 1),
    },
    speed: {
      turnMedianMs: med(a.durations), turnP90Ms: p90v(a.durations),
      apiMs: a.api, toolMs: a.tool, wallMs: a.wall,
    },
    byPos: a.byPos.map((p, i) => ({
      pos: posLabel(i), turns: p.turns, toolResults: p.tr, errors: p.err,
      reread: p.reread, rework: p.rework, ctxMedian: med(p.ctx), durMedianMs: med(p.dur),
    })),
    byBand: a.byBand.map((b, i) => ({
      band: bandLabel(i), turns: b.turns, toolResults: b.tr, errors: b.err,
      reread: b.reread, rework: b.rework, durMedianMs: med(b.dur),
    })),
    days_: Object.fromEntries(Object.entries(a.days).map(([d, v]) => [d, { turns: v.turns, usd: v.usd, cacheRead: v.read }])),
    compacts: a.compacts.length,
    hookCtxTok: a.hookCtxTok,
    hooks: a.att,
    hookEvents: a.attEvents,
  };
}

/* ── what a person needs to decide whether to start fresh (UserPromptSubmit) ──
   "A long context makes the model dumber" does not show up in the measurements
   here — see the confounding check in `quality`. Stratified by turn position, the
   tool failure rate stayed between 2.8% and 4.1% as the context grew from 120K to
   420K. So this hook never says "it is long, cut it". The only thing it can say
   honestly is the price: what re-reading this context every turn is costing. Whether
   to cut is a human call, made on whether the subject changed. */
const NUDGE_STATE = path.join(STATE_DIR, '.nenpi-nudge.json');
const NUDGE_CTX = envInt('NENPI_NUDGE_CTX', 200000);   // show the price above this context size
const NUDGE_EVERY = envInt('NENPI_NUDGE_EVERY', 40);   // after saying it once, stay quiet for this many prompts
/* 400K was too high to ever fire — zero firings, against a 7-day maximum context of
   360K. And 67% of all cache_read came from sessions past 500 turns, one of which
   ran 2,400 turns while never exceeding a 120K context. Width alone does not catch
   a long conversation, so length triggers the price too. What gets said is unchanged
   — the price, nothing more — and cutting is still the human's call. */
const NUDGE_LONG = envInt('NENPI_NUDGE_LONG', 60);           // after this many prompts, show the price even if the context is thin
const NUDGE_LONG_CTX = envInt('NENPI_NUDGE_LONG_CTX', 100000); // but never for a genuinely small context
const NUDGE_TAIL = 256 * 1024;   // do not read the whole transcript per prompt, only its tail
const CACHE_READ_USD = { opus: 1.5, sonnet: 0.3, haiku: 0.08 }; // $ per 1M tokens

export const rateFor = (model) => {
  const m = String(model || '').toLowerCase();
  for (const k of Object.keys(CACHE_READ_USD)) if (m.includes(k)) return CACHE_READ_USD[k];
  return CACHE_READ_USD.opus;
};

// Reading a huge transcript in full on every prompt would make this hook the slow
// part, so only the tail is taken.
export function tailLines(file, bytes = NUDGE_TAIL) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return []; }
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split(String.fromCharCode(10));
    if (size > len) lines.shift();   // the first line was cut mid-way
    return lines;
  } catch { return []; } finally { try { fs.closeSync(fd); } catch { /* noop */ } }
}

// The first assistant usage found from the end is how much context the conversation
// is currently carrying.
export function lastContext(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (!l || l.indexOf('"usage"') < 0) continue;
    let o; try { o = JSON.parse(l); } catch { continue; }
    const u = o?.message?.usage;
    if (!u) continue;
    const ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0)
      + (u.cache_creation_input_tokens || 0);
    if (ctx > 0) return { ctx, model: o.message.model };
  }
  return null;
}

export function nudgeText(ctx, model, prompts) {
  const usd = (ctx / 1e6) * rateFor(model);
  return '[nenpi] ' + t(
    'context ' + Math.round(ctx / 1000) + 'K tok (prompt #' + prompts + '). From here every turn costs about $'
      + usd.toFixed(2) + ' just to re-read it. If the subject has changed, /clear gets that back; if this is '
      + 'the same subject, carry on.',
    '文脈 ' + Math.round(ctx / 1000) + 'K tok（発言 ' + prompts
      + ' 回目）。以後1ターン進むごとに、読み直しだけで約 $' + usd.toFixed(2)
      + '。題目が前と変わっているなら /clear で戻せる。同じ題目の続きならこのままでよい。');
}

export function nudgeDecide(state, id, ctxInfo, now = Date.now()) {
  for (const k of Object.keys(state)) {
    if (now - (state[k].at || 0) > 7 * 86400e3) delete state[k];  // do not let the ledger grow
  }
  const e = state[id] || (state[id] = { prompts: 0, lastNudge: -NUDGE_EVERY, at: now });
  e.prompts++; e.at = now;
  if (!ctxInfo) return '';
  const fat = ctxInfo.ctx >= NUDGE_CTX;                                   // wide
  const long = e.prompts >= NUDGE_LONG && ctxInfo.ctx >= NUDGE_LONG_CTX;  // long
  if (!fat && !long) return '';
  if (e.prompts - e.lastNudge < NUDGE_EVERY) return '';
  e.lastNudge = e.prompts;
  return nudgeText(ctxInfo.ctx, ctxInfo.model, e.prompts);
}

function hookPrompt() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { raw += d; });
  process.stdin.on('end', () => {
    let out = '';
    try {
      const ev = JSON.parse(raw);
      const id = ev.session_id || ev.sessionId;
      const tp = ev.transcript_path || ev.transcriptPath;
      if (id && tp && !muted(ev.cwd)) {
        let st = {};
        st = readState(path.basename(NUDGE_STATE)) || {};
        out = nudgeDecide(st, id, lastContext(tailLines(tp)));
        try { fs.writeFileSync(NUDGE_STATE, JSON.stringify(st)); } catch { /* noop */ }
      }
    } catch { /* フックは何があっても会話を止めない */ }
    if (out) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: out },
      }));
    }
    process.exit(0);
  });
}

/* ── the cost of not bundling (PostToolUse) ─────────────────
   Over 30 days, firing tools one at a time added 3,027 turns — 30.7% of every turn
   that used a tool — and 1.28 billion tokens of re-sent context. CLAUDE.md already
   says "bundle them"; the measured bundling rate was still 1.2%. By the back half of
   a session that instruction is too far away to reach. So this says it once, at the
   moment it happens, and leaves the judgement of whether the calls actually depend
   on each other to the model. */
const BUNDLE_STATE = path.join(STATE_DIR, '.nenpi-bundle.json');
const BUNDLE_TAIL = 512 * 1024; // tail of the transcript; enough for the last 3 responses
// This used to infer bundling from the gap between completion times (2s). But Claude
// Code runs writing Bash calls serially, so even bundled into one turn the gaps are
// however long the commands took (4-5s), and four bundled calls got reported as one
// at a time. It now reads the transcript and counts tool_use per requestId — the same
// way report and effect count.
const BUNDLE_RUN = envInt('NENPI_BUNDLE_RUN', 3);            // how many one-at-a-time turns in a row before speaking
const BUNDLE_COOLDOWN = envInt('NENPI_BUNDLE_COOLDOWN', 20); // after speaking, stay quiet for this many tool calls
const BUNDLE_MAX = envInt('NENPI_BUNDLE_MAX', 8);            // cap per session; if 8 times did not help, stop saying it
// (Replaying 30 days, the worst session would have fired 87 times. Every word widens
//  the context and that gets re-sent every turn, so silence is cheaper — and it keeps
//  effect's sample from being dominated by one session.)

// If the BUNDLE_RUN responses before the current one (the response containing
// toolUseId) each called the same single tool, return that tool's name; otherwise ''.
// The current response does not count — tool_use lines are written as they arrive, so
// its total is not settled yet. Responses across a human prompt do not count either:
// they were one at a time because the questions were separate.
export function bundleVerdict(turns, toolUseId) {
  let cur = toolUseId ? turns.findIndex((x) => x.ids.includes(toolUseId)) : -1;
  if (cur < 0) cur = turns.length - 1;   // not found: treat the last response as current
  if (cur < 0) return '';
  const seg = turns[cur].seg;
  const prev = [];
  for (let i = cur - 1; i >= 0 && prev.length < BUNDLE_RUN; i--) {
    if (turns[i].seg !== seg) break;
    if (turns[i].tools === 0) continue;
    prev.push(turns[i]);
  }
  if (prev.length < BUNDLE_RUN) return '';
  const first = prev[0].names[0];
  return prev.every((x) => x.tools === 1 && x.names[0] === first) ? first : '';
}

// runName is bundleVerdict's answer. All this decides is whether to say it.
export function bundleDecide(state, id, runName, now = Date.now()) {
  for (const k of Object.keys(state)) {
    if (now - (state[k].at || 0) > 86400e3) delete state[k];   // do not let the ledger grow
  }
  const e = state[id] || (state[id] = { mute: 0, said: 0, at: now });
  e.at = now;
  delete e.calls;   // call history from the old timestamp-gap method; unused now
  if (e.mute > 0) { e.mute--; return ''; }
  if ((e.said || 0) >= BUNDLE_MAX) return '';
  if (!runName) return '';
  e.mute = BUNDLE_COOLDOWN;
  e.said = (e.said || 0) + 1;
  return '[nenpi] ' + t(
    runName + ' has run one call at a time for ' + BUNDLE_RUN + ' turns straight. If the calls are '
      + 'independent, send them in one turn (every extra turn re-sends the whole context). If each one '
      + 'depends on the last, carry on.',
    runName + ' が ' + BUNDLE_RUN
      + 'ターン続けて1本ずつ。独立した呼びなら1ターンにまとめて撃つ'
      + '（1ターン増やすたびに文脈が丸ごと再送される）。前の結果に依存しているならこのままでよい。');
}

function hookPost() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { raw += d; });
  process.stdin.on('end', () => {
    let out = '';
    try {
      const ev = JSON.parse(raw);
      const id = ev.session_id || ev.sessionId;
      const tp = ev.transcript_path || ev.transcriptPath;
      if (id && tp && !muted(ev.cwd)) {
        const { turns } = foldResponses(tailLines(tp, BUNDLE_TAIL));
        const run = bundleVerdict(turns, ev.tool_use_id || ev.toolUseId);
        let st = {};
        st = readState(path.basename(BUNDLE_STATE)) || {};
        out = bundleDecide(st, id, run);
        try { fs.writeFileSync(BUNDLE_STATE, JSON.stringify(st)); } catch { /* noop */ }
      }
    } catch { /* フックは何があっても会話を止めない */ }
    if (out) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: out },
      }));
    }
    process.exit(0);
  });
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const cmd = process.argv[2];
  const sub = process.argv[3];
  const days = (() => {
    const i = process.argv.indexOf('--days');
    return i > -1 ? (Number(process.argv[i + 1]) || 30) : 30;
  })();
  const li = process.argv.indexOf('--lang');
  if (li > -1 && process.argv[li + 1]) process.env.NENPI_LANG = process.argv[li + 1];

  if (cmd === 'hook' && sub === 'pre') hookPre();
  else if (cmd === 'hook' && sub === 'prompt') hookPrompt();
  else if (cmd === 'hook' && sub === 'post') hookPost();
  else if (cmd === 'top') top(days);
  else if (cmd === 'baseline') baseline(days);
  else if (cmd === 'quality') quality(days, process.argv.includes('--json'));
  else if (cmd === 'effect') effect(days);
  else if (cmd === 'errors') errors(days, process.argv.includes('--json'), (() => { const i = process.argv.indexOf('--split'); return i > -1 ? process.argv[i + 1] : null; })());
  else if (cmd === 'report' || !cmd) report(days);
  else {
    // The same text answers `nenpi help` and a command nobody has. Only the
    // second one is an error, so only the second one says so and exits non-zero.
    const asked = cmd === 'help' || cmd === '--help' || cmd === '-h';
    if (!asked) console.error(t('unknown command: ', '知らないコマンド: ') + cmd + '\n');
    console.log('usage: nenpi <command> [options]');
    console.log('');
    console.log('  report     ' + t('where the tokens went, diffed against the baseline', '何にトークンが燃えたか。基準があれば差分も出す'));
    console.log('  top        ' + t('the heaviest sessions', '重いセッション一覧'));
    console.log('  baseline   ' + t('freeze the current numbers as the baseline', '今の数字を基準として保存する'));
    console.log('  quality    ' + t('fuel, intelligence and speed gauges together', '燃費計・知能計・速度計をまとめて見る'));
    console.log('  effect     ' + t('did the nudges actually change anything', '口出しが実際に効いたかを見る'));
    console.log('  errors     ' + t('tool failures, environment-caused vs model-caused', 'ツール失敗の内訳（環境起因/モデル起因）'));
    console.log('  hook pre|prompt|post   ' + t('hook entry points (event JSON on stdin)', 'フックの入口（stdin に イベントJSON）'));
    console.log('');
    console.log('  --days N   ' + t('window in days (default 30)', '対象とする日数（既定 30）'));
    console.log('  --lang     ' + t('en or ja (also NENPI_LANG)', 'en か ja（環境変数 NENPI_LANG も可）'));
    console.log('  --json     ' + t('machine-readable output (quality, errors)', '機械可読な出力（quality / errors）'));
    console.log('  --split T  ' + t('errors: compare before and after a timestamp', 'errors: ある時刻の前後で比べる'));
    process.exit(asked ? 0 : 1);
  }
}
