# Follow-ups

Open items found during review that were deliberately not fixed in the branch that found them. Each names where it came from and what closing it takes. Ordered by priority: a guard bypass or release blocker first, then wrong behaviour that fails safe or over-asks, then eval-suite coverage, then documented scope limits.

## Tier 1: a guard can be bypassed or the release is blocked

Nothing open. The marketplace install was verified on 2026-09-18: `claude plugin marketplace add BobMali/cc-harness` records `{ "source": "github", "repo": "BobMali/cc-harness" }`, the shape `init` writes into `extraKnownMarketplaces`, and `claude plugin install cc-harness@cc-harness` installs 0.1.0.

## Tier 2: wrong behaviour that fails safe or over-asks

- **Switching `--marketplace` from a repo to a local path leaves the old GitHub entry in `settings.json`.** The requested source replaces the entry in the file it targets, but a repo-to-path switch targets `settings.local.json` and never revisits the shared file. Fix: drop the `cc-harness` marketplace key from `settings.json` when the new source is local.

## Tier 3: eval-suite coverage and privacy

Nothing open. Closed on 2026-09-19: `smbclient -U user%pass` redaction, the cwd substitution at `:` `;` `,`, the sed `w` command as a write, `node --check` over `evals/`, PostToolUse twins for every mined edit-tool vector, and `doctor` checks for a stale workflow or a drifted owned-entries record.

## Tier 4: documented scope limits, no action planned

- **A hand-added permission entry identical to a retired harness entry is removed with it.** Ownership is recorded by text in `.claude/harness.owned.json`, so an entry the user typed that equals one `init` wrote cannot be told apart. Re-add it after the re-init.
- **Path fragments inside scripts read as real paths.** The test guard's Bash arm matches paths token by token, so a fragment like `root + "/cmd/exit_test.go"` inside a heredoc looks like an absolute path outside the project and does not ask. Textual analysis cannot resolve the concatenation; the old whole-segment match asked on every mention instead, including scratch-directory copies.
- **Shell variables and command substitution hide the tool word.** `G=git; $G reset --hard` or `$(which git) reset --hard` resolve to `$G` / `$(which`, so no guard applies; closing this needs shell emulation, which the guards deliberately do not attempt. Used as the runner fixture's known-gap vector (`test/fixtures/evals/corpus/adversarial/git.jsonl`, `ts-000011`).
- **Native Windows.** Checks run through `/bin/sh`; on Windows every check aborts and the quality gate blocks every edit. Documented as unsupported; use WSL. Fix if ever needed: `process.platform === 'win32' ? process.env.ComSpec : '/bin/sh'` plus quoting rules.
- **Windows-style paths inside Bash commands are not scrubbed.** Transcripts here are macOS.
- **"Missing `file_path`" on an edit tool is unrepresentable as a vector** (`validateVector` requires a string); the guard's `!fp` branch is covered by unit tests only.
