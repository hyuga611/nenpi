# nenpi

**nenpi** (燃費, "fuel economy") tells you *where* a Claude Code session burns its tokens, not just how much it spent.

If you want the bill, use [ccusage](https://github.com/ryoppippi/ccusage) — it does that job well. nenpi answers a different question: **which tool output entered the conversation, and how many turns did you keep paying to re-read it?** That number is `cache_read`, it is usually 60–80% of everything you spend, and no dollar total tells you what caused it.

Zero dependencies. Reads only the JSONL transcripts already on your disk under `~/.claude/projects/`. Nothing is uploaded anywhere.

## Install

Node 18 or newer. Run it without installing:

```
npx @hyuga/nenpi report
```

Or install it, which also puts `nenpi` on your PATH for the hooks below:

```
npm i -g @hyuga/nenpi
nenpi report
```

## What it shows

### Residency cost — the metric this tool exists for

Every turn re-sends the whole context. So a tool result is not charged once; it is charged once per turn that follows it. **Residency cost = tokens injected × turns that came after.** Sort by that and the real cost centre stops being a guess:

```
## Residency cost (tokens injected x turns that followed) = what cache_read really is
    resid  share  calls injected     avg  imgs  tool
    1669M  81.4%   5586     2.4M     432     0  Bash
     231M  11.3%    229     0.3M    1474   163  Read
      43M   2.1%     64     0.1M     950    34  mcp__claude-in-chrome__computer
      17M   0.8%    372     0.0M      55     0  Write
```

Bash output here is 2.4M tokens of text but 1669M of residency — it arrived early and never left. That is the thing worth fixing, and a cost report by day would never have pointed at it.

### The rest of `report`

```
# nenpi — last 7 days / 69 sessions / 7,023 turns

## Measured tokens
  cache_read  re-reading the context every turn    818M → weighted     82M  59.8%
  cache_write adding to the context                19M → weighted     24M  17.6%
  output      replies and thinking                6.2M → weighted     31M  22.6%

## Context length per turn
  median 118,351 / p90 158,406 / max 295,024
  fixed startup cost (median) 28,851 tok

## Turn efficiency
  tool_use 6,971 calls / 6,701 tool turns = 1.04 per turn
  share of tool turns that bundled more than one call: 3.3%

## Diagnosis
  [warn] parallel tool calls 3.3% -> bundle independent Read/Bash calls into one turn
  [warn] startup cost 28,851 tok x 7,023 turns = 203M -> trim skillListingMaxDescChars and unused MCP servers
  [warn] 4 sessions over 500 turns account for 72.8% of cache_read -> split them up with /clear
```

### `quality` — spending less is only good if nothing else got worse

Cutting tokens is easy if you are allowed to make the agent worse. `quality` puts fuel, intelligence and speed on one screen so a "win" has to hold on all three: rework rate, tool failure rate, user correction rate, wasted-Read rate, turns per prompt, wall time per prompt, plus a correlation table of context length against each metric — and a confounding check that stratifies by turn position, because context length and turn position are usually the same axis under two names.

### `effect` — did your hook actually change anything?

Comparing week to week confounds: spend fell, but was that your change or an easier week? `effect` compares, **inside the same session**, the turns immediately after a nudge fired against ordinary turns. Whatever the work was, it applies to both sides and cancels out.

```
## "bundle them" (hook post) — did the next turn actually bundle?
  fired                             80 times
  bundled on the next turn           8 / 79   10.1%
  normal turns, same sessions      201 / 6401   3.1%
  difference                    +7.0pt
  → It does not work. Reword it, or take it out.
```

It tells you when your own nudge is not working, which is the part that is easy to
never find out.

### `errors` — is the model getting worse, or is it your machine?

A rising tool failure rate is not evidence the model regressed. Permission denials, `EPERM`, a human pressing stop — all of those raise it. `errors` splits environment-caused failures from model-caused ones, broken down by model × effort, with `--split <timestamp>` to compare before and after you changed something.

## Hooks

The same file is three Claude Code hooks. They are the point where measurement turns into a smaller bill.

| Hook | Event | What it does |
| --- | --- | --- |
| `nenpi hook pre` | `PreToolUse` | A full-file `Read` of a large file gets its window cut to the first 400 lines, with a note to `Grep` first and then read with `offset`/`limit`. Full text would sit in the context and be re-sent every turn. |
| `nenpi hook prompt` | `UserPromptSubmit` | Shows what re-reading the current context costs per turn. It never says "the context is too long" — that claim did not hold up in the measurements. Whether to `/clear` is a human call, made on whether the subject changed. |
| `nenpi hook post` | `PostToolUse` | When the same tool has run one call at a time for several turns straight, says so once, at the moment it happens. Whether the calls actually depend on each other is left to the model. |

In `~/.claude/settings.json`, with `nenpi` on your PATH (`npm i -g @hyuga/nenpi`):

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Read", "hooks": [{ "type": "command", "command": "nenpi hook pre" }] }
    ],
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "nenpi hook prompt" }] }
    ],
    "PostToolUse": [
      { "hooks": [{ "type": "command", "command": "nenpi hook post" }] }
    ]
  }
}
```

Running from a clone instead: `node /path/to/nenpi/src/nenpi.mjs hook pre`.

Every hook fails open: on any error it exits 0 and says nothing.

## Commands

```
nenpi report   [--days 30]   where the tokens went, diffed against the baseline
nenpi top      [--days 30]   the heaviest sessions
nenpi baseline [--days 30]   freeze the current numbers as the baseline
nenpi quality  [--days 30]   fuel, intelligence and speed gauges together
nenpi effect   [--days 30]   did the nudges actually change anything
nenpi errors   [--days 30]   tool failures, environment-caused vs model-caused
nenpi hook pre|prompt|post   hook entry points (event JSON on stdin)

--days N    window in days (default 30)
--lang      en or ja (also NENPI_LANG; defaults to your locale, else English)
--json      machine-readable output (quality, errors)
--split T   errors: compare before and after a timestamp
--anonymize top: replace the project column with a digest (also NENPI_ANONYMIZE)
```

`nenpi baseline` freezes the current numbers so the next `report` and `quality` show a diff. It overwrites the previous baseline, so take one deliberately — after a change you want to measure from, not on every run.

## Configuration

All state lives in `~/.claude/nenpi/` (`NENPI_STATE_DIR` to move it). If you have an older install, whatever is still in `~/.claude/tools/` is read from there until the new location has its own copy. Every threshold can be overridden from the environment, so hooks can be tuned per machine without editing the source:

| Variable | Default | Meaning |
| --- | --- | --- |
| `NENPI_BIG_FILE` | `61440` | A full-file `Read` above this many bytes gets cut. |
| `NENPI_READ_LIMIT` | `400` | How many lines it is cut to. |
| `NENPI_NUDGE_CTX` | `200000` | Show the price above this context size. |
| `NENPI_NUDGE_EVERY` | `40` | After saying it once, stay quiet for this many prompts. |
| `NENPI_NUDGE_LONG` | `60` | After this many prompts, show the price even for a thin context. |
| `NENPI_NUDGE_LONG_CTX` | `100000` | …but never below this context size. |
| `NENPI_BUNDLE_RUN` | `3` | One-at-a-time turns in a row before the bundling nudge speaks. |
| `NENPI_BUNDLE_COOLDOWN` | `20` | Tool calls of silence after it speaks. |
| `NENPI_BUNDLE_MAX` | `8` | Cap per session — if 8 times did not help, stop saying it. |
| `NENPI_LANG` | locale | `en` or `ja`. |
| `NENPI_ANONYMIZE` | unset | `1` to hash the project column in `top`. |

## What leaves your machine, and what the output contains

Nothing leaves. There is no `fetch`, no `node:http`, no `child_process` anywhere in the source, and no dependencies through which one could arrive later. It reads the JSONL transcripts under `~/.claude/projects/` and writes only to `~/.claude/nenpi/` (a saved baseline and the nudges' cooldown counters).

The part worth knowing is about the output rather than the tool. `report`, `quality`, `effect` and `errors` print tool names and numbers — nothing that identifies a project. **`top` prints one column that is a name: the directory under `~/.claude/projects/`, which is your working directory with its separators flattened.** On a machine that does client work, the client's name is in that path, so it is in that column.

So `nenpi top --anonymize` replaces it with `proj-<8 hex>`, stable across runs so rows stay comparable. Without the flag, `top` says so in a line under the table. This hides a name from a reader; it will not stop someone who already has a list of candidate names and hashes them — it is a guard against pasting, not a guarantee of anonymity.

## How the numbers are made, and what is estimated

Being straight about this matters more than the numbers looking precise.

**Measured, from the transcripts:** `input`, `output`, `cache_read`, `cache_creation` token counts; tool call counts; timestamps; hook durations; `is_error` flags; compaction events. Dollar figures printed in `quality` as "measured cost-state total" come from Claude Code's own `costUSD`, not from a model of ours.

**Estimated:**

- **`BYTES_PER_TOK = 3.5`** — tool output is measured in bytes and converted to tokens with this ratio. It is a rough average for mixed Japanese and English; adjust your reading of `injected` and residency accordingly.
- **`IMG_TOK = 1600`** — one image block is counted as this many tokens.
- **Weights `W = { in: 1, write: 1.25, read: 0.1, out: 5 }`** — token classes are converted to "input-token equivalents" so a single number can rank them. These follow Anthropic's published price ratios. `quality` prints a **calibration residual**: it derives a unit price from the real `costUSD` and reports how far off the weighted model is. On the author's machine that residual runs around 1%. If yours is large, the weights do not match your plan and the weighted percentages should be read as rough.

So: **charges are measured from `usage`; the attribution of those charges to individual tools is estimated.** Residency cost is the estimated half. It is still the most useful number here, because nothing else points at *which* output is the expensive one — but it is an estimate, and treating it as one is the right call.

**One more caveat:** Claude Code's JSONL transcript format is undocumented and changes. nenpi's counting is pinned to `message.id` and `requestId` (see below), which have been stable, but a format change can silently make a metric wrong. If a number looks impossible, it probably is — please open an issue.

## Why counting by line is wrong

Claude Code splits one API response into a separate JSONL line per `thinking` / `text` / `tool_use` block, and copies the same `usage` object onto every one of them. Summing per line counts the same charge several times over — measured here at **+82%**. nenpi deduplicates by `message.id`.

The same split breaks bundling detection: from a single line you cannot tell how many tools one response called, so a per-line count pins the bundling rate at 0.0% forever. nenpi regroups the lines by `requestId` first.

---

# nenpi（日本語）

**nenpi（燃費）** は、Claude Code のセッションが**どこで**トークンを燃やしているかを出す。いくら使ったか、ではなく。

金額は [ccusage](https://github.com/ryoppippi/ccusage) が既にうまくやっている。nenpi が答えるのは別の問いで、**どのツール出力が文脈に入り、そのあと何ターン読み直され続けたか**。それが `cache_read` の正体で、たいてい総消費の 60〜80% を占めるが、日別の金額表からは何が原因かが一切わからない。

依存ゼロ。読むのは `~/.claude/projects/` にすでにある JSONL だけ。どこにも送らない。

```
npx @hyuga/nenpi report --lang ja
```

## 滞在コスト — このツールがある理由

毎ターン、文脈は丸ごと再送される。だからツールの出力は1回課金されるのではなく、**そのあとに続いたターンの数だけ**課金される。**滞在コスト = 投入トークン × それ以降のターン数**。これで並べ替えると、金食い虫が推測ではなくなる。

```
## 滞在コスト（投入tok × それ以降のターン数）= cache_read の実体
     滞在    割合   回数   投入tok    平均  画像  ツール
    1669M  81.4%   5586     2.4M     432     0  Bash
     231M  11.3%    229     0.3M    1474   163  Read
      43M   2.1%     64     0.1M     950    34  mcp__claude-in-chrome__computer
      17M   0.8%    372     0.0M      55     0  Write
```

Bash の出力は本文としては 2.4M tok だが、滞在コストは 1669M。早い時点で入ってそのまま居座ったからで、日別の金額レポートでは絶対に指を差せない。

## そのほか

- **`quality`** — 燃費だけ下がって賢さが落ちていたら失敗。燃費・知能（手戻り率／ツール失敗率／訂正率／空振り Read 率）・速度を1画面に並べ、3つ揃って初めて「改善」と呼ぶ。文脈長との相関表と、ターン位置で層別した交絡の確認つき。
- **`effect`** — 週次比較は交絡する（下がったのはフックのおかげか、今週が楽だっただけか）。`effect` は**同じセッションの中で**「口出しの直後のターン」と「平常時」を比べるので、作業の重さは両方に同じだけかかって差分から消える。
- **`errors`** — ツール失敗率が上がっても、モデルが悪くなったとは限らない。権限拒否・`EPERM`・人が止めた分でも上がる。環境起因とモデル起因を分け、model × effort で並べ、`--split <時刻>` で設定変更の前後を切って比べられる。

## フック

同じファイルが3つのフックを兼ねる。計測が実際に請求を下げるのはここ。

- **`hook pre`（PreToolUse）** — 大きなファイルの全文 Read を先頭 400 行に切り、「Grep で当たりを付けてから offset/limit で読め」と添える。全文は文脈に居座り、毎ターン再送されるから。
- **`hook prompt`（UserPromptSubmit）** — 今の文脈を毎ターン読み直す値段を出す。「長いから切れ」とは言わない（実測でその主張は支持されなかった）。切るかどうかは「題目が変わったか」で人が決める。
- **`hook post`（PostToolUse）** — 同じツールを何ターンも1本ずつ撃っていたら、その場で一度だけ言う。依存しているかどうかの判断はモデルに残す。

設定例は英語側の JSON を参照。すべてのフックは fail-open で、何かあれば黙って exit 0 する。

## 基準

`nenpi baseline` は今の数字を留め、次回の `report` と `quality` がそこからの差分を出す。**前の基準は上書きされる**ので、毎回走らせるものではない。「ここから測りたい」と決めたときだけ打つ。状態は `~/.claude/nenpi/`（`NENPI_STATE_DIR` で移せる）。

## 外に出るもの・出力に含まれるもの

外には何も出ない。ソースのどこにも `fetch` も `node:http` も `child_process` も無く、依存パッケージが無いので後から生える口も無い。読むのは `~/.claude/projects/` の JSONL、書くのは `~/.claude/nenpi/`（保存した基準と、口出しのクールダウン）だけ。

知っておく価値があるのはツールではなく**出力のほう**。`report` / `quality` / `effect` / `errors` はツール名と数字しか出さない。**`top` だけは名前の列を持つ——`~/.claude/projects/` のディレクトリ名で、これは作業ディレクトリのパスを区切り文字ごと潰したもの。**客先の仕事をしている PC なら、そのパスに客先名が入っている。

そこで `nenpi top --anonymize` はこの列を `proj-<8桁>` に置き換える。同じ名前は毎回同じ値になるので、実行をまたいで行を突き合わせられる。付けなかった場合は表の下に一行そう書く。これは**読み手から名前を隠す**もので、候補の名前を持っている相手が総当たりでハッシュを突き合わせるのは防げない。貼り付け事故に対する備えであって、匿名性の保証ではない。

## 実測と推定の線引き

- **実測**：`usage` のトークン数、ツール呼び出し回数、時刻、フックの所要時間、`is_error`、compact の発生。`quality` の「実測 cost-state 合計」は Claude Code 自身の `costUSD`。
- **推定**：`BYTES_PER_TOK = 3.5`（バイト→トークン換算）、`IMG_TOK = 1600`（画像1枚）、重み `W = { in: 1, write: 1.25, read: 0.1, out: 5 }`（入力トークン換算）。

つまり **課金値は `usage` から実測、帰属の按分は推定**。滞在コストは推定側にある。それでもこの数字がいちばん役に立つのは、「どの出力が高いのか」を指せるものが他に無いからで、推定だと承知の上で読むのが正しい。

`quality` は**較正残差**を出す。実測の `costUSD` から単価を割り出し、重みモデルとのズレを % で表示する。この PC では 1% 前後。大きく出るなら重みが契約と合っていないので、重み付きの割合は目安として読むこと。

## 行で数えると間違う

Claude Code は1回の API 応答を `thinking` / `text` / `tool_use` ごとに別行へ分割して書き、その各行が同じ `usage` を持つ。行単位で足すと同じ課金を何度も数える（実測 **+82%**）。nenpi は `message.id` で重複を落とす。

同じ分割のせいで並列も判定できない。1行からは「その応答が何個ツールを呼んだか」が見えないので、行で数えると並列率は永遠に 0.0% になる。nenpi は先に `requestId` でまとめ直す。

---

MIT © hyuga611
