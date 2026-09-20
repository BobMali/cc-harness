# Follow-ups

Open items found during review that were deliberately not fixed in the branch that found them. Each names where it came from and what closing it takes. Ordered by priority: a guard bypass or release blocker first, then wrong behaviour that fails safe or over-asks, then eval-suite coverage, then documented scope limits.

## Tier 1: a guard can be bypassed or the release is blocked

Nothing open. The marketplace install was verified on 2026-09-18: `claude plugin marketplace add BobMali/cc-harness` records `{ "source": "github", "repo": "BobMali/cc-harness" }`, the shape `init` writes into `extraKnownMarketplaces`, and `claude plugin install cc-harness@cc-harness` installs 0.1.0.

## Tier 2: wrong behaviour that fails safe or over-asks

Nothing open. Closed on 2026-09-20: block insertion inside `describe()` groups (indentation-relative matching, with a group opener allowing a deeper first child), and the repo-to-local `--marketplace` switch now removes the GitHub entry from the shared settings.

## Tier 3: eval-suite coverage and privacy

Nothing open. Closed on 2026-09-19: `smbclient -U user%pass` redaction, the cwd substitution at `:` `;` `,`, the sed `w` command as a write, `node --check` over `evals/`, PostToolUse twins for every mined edit-tool vector, and `doctor` checks for a stale workflow or a drifted owned-entries record.

## Tier 4: scope limits

What is left after 2026-09-19, each with the reason it stays open.

- **Block insertion covers JS/TS and Go only.** PHP and Swift test files never qualify; additions there ask unless they are appends. Add a language when a mined corpus for it exists to measure against.
- **Block detection assumes formatted code.** The column-0 heuristics treat an unindented line inside a test body as top-level code, so a stray `}` at column 0 could let an insertion through that should ask, and a template literal with column-0 content makes a legitimate block ask. Unbalanced text always falls to ask.
- **Shell functions and aliases hide the tool word.** `g() { git "$@"; }; g reset --hard` resolves to `g`. Simple same-command assignments (`G=git; $G …`) and `$(which git)` are resolved now; functions and aliases need shell emulation, which the guards do not attempt. Substitution happens only at the start of a segment, so a prefix before the variable (`sudo $G reset --hard`) is not resolved either. Used as the runner fixture's known-gap vector (`test/fixtures/evals/corpus/adversarial/git.jsonl`, `ts-000011`).
- **Path fragments inside scripts read as real paths.** A fragment like `root + "/cmd/exit_test.go"` inside a heredoc looks like an absolute path outside the project and does not ask. The conservative alternative, matching heredoc bodies as text, was measured against the mined corpus: 71 commands whose heredoc body merely mentions a test file (notes, commit bodies) would start asking. Left open on that evidence.
- **Windows is unit-tested with fakes only.** `shellFor` resolution, the abort message, and the doctor finding are covered by tests that simulate `win32`; nothing here has run on Windows. Also, `doctor` compares the workflow byte for byte, so a checkout with `core.autocrlf` would report it stale.
