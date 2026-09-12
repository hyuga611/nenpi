# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
