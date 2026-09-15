# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.5 — 2026-09-15

The counting method moves to v3. A baseline saved by 0.1.4 or earlier is not compared
against: `report` and `quality` say so and ask you to retake it with
`nenpi baseline --days N`.

### Fixed

- **`--days` filters by the time of each line**, not by the file's modification time.
  A session file touched today used to bring all of its older lines into the window,
  so `--days 1` could report weeks of spend.
- **Subagent transcripts are counted.** Claude Code writes them to
  `<session>/subagents/*.jsonl`, which was never read, so a session that delegated most
  of its work looked cheap. Their spend now counts toward the session that started
  them; they are not counted as sessions of their own, do not add to the startup cost,
  and the task handed to a subagent is not counted as a user prompt or correction. In
  `top` they appear as separate rows marked "(subagent)".
- **A split response whose first line has no `usage` is no longer dropped.** The
  message id was marked as seen before `usage` was checked, so the later line that
  carried it was skipped as a duplicate.
- **A transcript line that is valid JSON but not an object (`null`) no longer crashes**
  `report`, `quality`, `effect` or `errors`.
- **`effect` recognises the hook commands the README shows.** Only a quoted
  `nenpi.mjs"` path was matched, so `nenpi hook post`, `npx @hyuga/nenpi hook post` and an
  unquoted path were never seen as nudges firing.
- **Tool output is sized in UTF-8 bytes, as documented.** String length was used, which
  put Japanese text at a third of its real size in `injected`, residency and hook
  context tokens.
- **A 0% intelligence metric in the baseline is compared, not skipped.** A tool failure
  rate going from 0% to 100% used to read as "no baseline", so the verdict could say
  "on target". It now reads as worse (change shown as "—"); 0% to 0% reads as unchanged.
  A 0 in the fuel or speed row still means nothing was recorded.
- **Hook keys no longer carry the hook's arguments.** A hook is named by its script and
  subcommand (`redline hook pre`); anything after that, and any `VAR=value` prefix, is
  dropped. Arguments could hold a token, and the key is written to `quality --json` and
  to the saved quality baseline. A baseline saved by an earlier version keeps whatever
  it recorded until you retake it.
- **Transcripts are read line by line** instead of whole, so a file too large for one
  string is no longer skipped, and `quality` no longer holds a whole session as parsed
  objects. A file that cannot be read is still left out, but the command now says how
  many on stderr instead of passing over them in silence.

### Changed

- **`errors --anonymize`** (also `NENPI_ANONYMIZE=1`) leaves out the section with the
  first line of each error. That text is raw tool output and can quote a path, a URL or
  a token. Without the flag the section stays and says so in one line. `errors --json`
  never included it.
- The session count in `report` now counts only sessions with activity inside the
  window.

## 0.1.4 — 2026-09-12

### Added

- **`nenpi top --anonymize`** (also `NENPI_ANONYMIZE=1`) replaces the project column
  with `proj-<8 hex>` of itself. `top` is the only command that prints a name rather
  than a number: the column is the directory under `~/.claude/projects/`, which is the
  working directory with its separators flattened, so on a machine that does client
  work the client's name is in it. The digest is stable across runs, so rows can still
  be matched between one report and the next. It hides a name from a reader; it does
  not withstand someone hashing a list of candidate names, so it is a guard against
  pasting rather than a guarantee of anonymity.
- **`top` says so when the flag is off**, in one line under the table. Nothing else
  about the output changes, so existing scripts that read the rows are unaffected.
- **README now states what leaves the machine** (nothing — no `fetch`, no `node:http`,
  no `child_process`, no dependencies) and which commands print identifying text.

## 0.1.3 — 2026-09-12

### Changed

- **The bundle nudge is a third of its former length.** The text a PostToolUse hook
  prints is written into the transcript, so it is re-read on every turn that follows it
  — its real cost is length times the number of turns left, not length once. At the old
  85 tokens, a session had to save more than about 400 turns of context for the nudge to
  pay for itself, which made it net-negative in exactly the long sessions that carry most
  of the spend. It now reads `Bash x3 one at a time. If the next call is already decided,
  same turn.` (~35 tokens), moving break-even out to roughly 1,400 turns. The reasoning
  clause and the explicit "if each depends on the last, carry on" are gone; the latter is
  carried by the positive condition instead. Firing cadence is unchanged —
  `NENPI_BUNDLE_RUN`, `NENPI_BUNDLE_COOLDOWN` and `NENPI_BUNDLE_MAX` keep their defaults,
  and `nenpi effect` matches nudges by hook command rather than by text, so comparisons
  against earlier sessions still line up.

## 0.1.2 — 2026-09-10

### Fixed

- **An upgrade no longer loses the baseline.** State moved to `~/.claude/nenpi/` in
  0.1.0, and anyone upgrading found `report` and `quality` reporting no baseline at all
  while their old one sat untouched in `~/.claude/tools/`. Reads now fall back to the old
  directory; writes still go to the new one. This matters because the obvious way to make
  the message go away is `nenpi baseline`, which overwrites the very thing that was
  missing. The nudge and bundle ledgers carry over the same way, so upgrading no longer
  restarts the nudge cadence either.

## 0.1.1 — 2026-09-10

### Fixed

- **`nenpi help` exits 0.** The usage text was only ever reached as the catch-all for a
  command that does not exist, so asking for help returned 1 and any script that checked
  the exit code treated it as a failure. A command nobody has still exits 1, and now says
  which one on stderr.

## 0.1.0 — 2026-09-10

First public release. nenpi ran privately for months before this; what changed to make
it publishable is listed below.

### Added

- **English output.** All output is bilingual. The language is chosen by `--lang en|ja`,
  then `NENPI_LANG`, then the locale variables (`LC_ALL` / `LC_MESSAGES` / `LANG`), then
  the OS locale reported by `Intl` — Windows sets none of the variables — defaulting to
  English.
- **English correction phrases.** The user-correction rate in `quality` used to detect
  Japanese phrasing only, so it silently read 0% for everyone else. English phrases are
  now matched too, case-insensitively.
- **Every threshold is configurable from the environment** — `NENPI_BIG_FILE`,
  `NENPI_READ_LIMIT`, `NENPI_NUDGE_CTX`, `NENPI_NUDGE_EVERY`, `NENPI_NUDGE_LONG`,
  `NENPI_NUDGE_LONG_CTX`, `NENPI_BUNDLE_RUN`, `NENPI_BUNDLE_COOLDOWN`,
  `NENPI_BUNDLE_MAX` — so the hooks can be tuned per machine without editing the source.
- **`NENPI_STATE_DIR`** to relocate state.

### Changed

- **State moved to `~/.claude/nenpi/`** from `~/.claude/tools/`. This covers the two
  baselines (`nenpi-baseline.json`, `nenpi-quality-baseline.json`) and the two hook
  ledgers (`.nenpi-nudge.json`, `.nenpi-bundle.json`). Copy the old files across to keep
  your baseline; regenerating one with `nenpi baseline` overwrites what you were
  measuring against.
- Source comments are in English.

### Notes on the numbers

Token charges are measured from the transcript's `usage`. Attributing those charges to
individual tools is estimated, using `BYTES_PER_TOK = 3.5`, `IMG_TOK = 1600` and the
weights `W = { in: 1, write: 1.25, read: 0.1, out: 5 }`. `quality` prints a calibration
residual against the real `costUSD` so you can see how far off the weights are on your
plan. See the README for the full disclosure.
