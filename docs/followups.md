# Follow-ups

Open items found during review that were deliberately not fixed in the branch that found them. Each names where it came from and what closing it takes. Ordered by priority: a guard bypass or release blocker first, then wrong behaviour that fails safe or over-asks, then eval-suite coverage, then documented scope limits.

## Tier 1: a guard can be bypassed or the release is blocked

Nothing open. The marketplace install was verified on 2026-09-18: `claude plugin marketplace add BobMali/cc-harness` records `{ "source": "github", "repo": "BobMali/cc-harness" }`, the shape `init` writes into `extraKnownMarketplaces`, and `claude plugin install cc-harness@cc-harness` installs 0.1.0.

## Tier 2: wrong behaviour that fails safe or over-asks

- **Switching `--marketplace` from a repo to a local path leaves the old GitHub entry in `settings.json`.** The requested source replaces the entry in the file it targets, but a repo-to-path switch targets `settings.local.json` and never revisits the shared file. Fix: drop the `cc-harness` marketplace key from `settings.json` when the new source is local.

## Tier 3: eval-suite coverage and privacy

Nothing open. Closed on 2026-09-19: `smbclient -U user%pass` redaction, the cwd substitution at `:` `;` `,`, the sed `w` command as a write, `node --check` over `evals/`, PostToolUse twins for every mined edit-tool vector, and `doctor` checks for a stale workflow or a drifted owned-entries record.

## Tier 4: scope limits

What is left after 2026-09-19, each with the reason it stays open.

- **Shell functions and aliases hide the tool word.** `g() { git "$@"; }; g reset --hard` resolves to `g`. Simple same-command assignments (`G=git; $G …`) and `$(which git)` are resolved now; functions and aliases need shell emulation, which the guards do not attempt. Substitution happens only at the start of a segment, so a prefix before the variable (`sudo $G reset --hard`) is not resolved either. Used as the runner fixture's known-gap vector (`test/fixtures/evals/corpus/adversarial/git.jsonl`, `ts-000011`).
- **Path fragments inside scripts read as real paths.** A fragment like `root + "/cmd/exit_test.go"` inside a heredoc looks like an absolute path outside the project and does not ask. The conservative alternative, matching heredoc bodies as text, was measured against the mined corpus: 71 commands whose heredoc body merely mentions a test file (notes, commit bodies) would start asking. Left open on that evidence.
- **Windows is unit-tested with fakes only.** `shellFor` resolution, the abort message, and the doctor finding are covered by tests that simulate `win32`; nothing here has run on Windows. Also, `doctor` compares the workflow byte for byte, so a checkout with `core.autocrlf` would report it stale.
