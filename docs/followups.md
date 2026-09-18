# Follow-ups

Open items found during review that were deliberately not fixed in the branch that found them. Each names where it came from and what closing it takes. Ordered by priority: a guard bypass or release blocker first, then wrong behaviour that fails safe or over-asks, then eval-suite coverage, then documented scope limits.

## Tier 1: a guard can be bypassed or the release is blocked

- **Marketplace install path untested end to end.** The README's `claude plugin marketplace add <owner>/cc-harness` needs the repo pushed; verify the recorded source shape in `~/.claude/plugins/known_marketplaces.json` matches what `init` writes into `extraKnownMarketplaces` before tagging 0.1.0.

## Tier 2: wrong behaviour that fails safe or over-asks

- **`init` renders CI check steps and the allow list from the preset only.** A hand-written `custom` config needs its CI steps added by hand (this repo did). Fix: render from `harness.json` when it exists, or add a `sync-ci` subcommand.
- **Wrapper flags and nested wrappers.** `yarn workspace app vitest …`, `pnpm -C dir exec …`, `npm --prefix x run …` resolve to the wrong tool word and over-ask.
- **Commit guard crashes on `-F <directory>`.** `fs.readFileSync` throws EISDIR; the dispatcher turns it into an `ask`, so it fails safe. Found by the eval runner's crash detection. Fix: wrap the read in try/catch and return `null`.
- **`deepMergeSettings` never removes entries.** A plugin upgrade that changes a harness-owned hook command would leave both entries. Needs an ownership marker before it matters.

## Tier 3: eval-suite coverage and privacy

- **`smbclient -U me%pw` and bare `mysql -p` are not redacted.** Low frequency; add when seen.
- **The miner emits PreToolUse vectors only.** Pairing each Edit/Write with a PostToolUse vector would exercise the quality gate on mined data (about 365 vectors).
- **The dogfood `syntax` check and the CI `syntax` step do not `node --check` files under `evals/`.** The `evals` check exercises the runner end to end instead.
- **The cwd substitution is boundary-anchored**, so `PATH=/cwd:/bin` forms keep the literal cwd (no username, since home directories are scrubbed separately).

## Tier 4: documented scope limits, no action planned

- **Path fragments inside scripts read as real paths.** The test guard's Bash arm matches paths token by token, so a fragment like `root + "/cmd/exit_test.go"` inside a heredoc looks like an absolute path outside the project and does not ask. Textual analysis cannot resolve the concatenation; the old whole-segment match asked on every mention instead, including scratch-directory copies.
- **Shell variables and command substitution hide the tool word.** `G=git; $G reset --hard` or `$(which git) reset --hard` resolve to `$G` / `$(which`, so no guard applies; closing this needs shell emulation, which the guards deliberately do not attempt. Used as the runner fixture's known-gap vector (`test/fixtures/evals/corpus/adversarial/git.jsonl`, `ts-000011`).
- **Native Windows.** Checks run through `/bin/sh`; on Windows every check aborts and the quality gate blocks every edit. Documented as unsupported; use WSL. Fix if ever needed: `process.platform === 'win32' ? process.env.ComSpec : '/bin/sh'` plus quoting rules.
- **Windows-style paths inside Bash commands are not scrubbed.** Transcripts here are macOS.
- **"Missing `file_path`" on an edit tool is unrepresentable as a vector** (`validateVector` requires a string); the guard's `!fp` branch is covered by unit tests only.
