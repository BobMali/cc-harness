# Follow-ups

Open items found during review that were deliberately not fixed in the branch that found them. Each names where it came from and what closing it takes. Ordered by priority: a guard bypass or release blocker first, then wrong behaviour that fails safe or over-asks, then eval-suite coverage, then documented scope limits.

## Tier 1: a guard can be bypassed or the release is blocked

Nothing open. The marketplace install was verified on 2026-09-18: `claude plugin marketplace add BobMali/cc-harness` records `{ "source": "github", "repo": "BobMali/cc-harness" }`, the shape `init` writes into `extraKnownMarketplaces`, and `claude plugin install cc-harness@cc-harness` installs 0.1.0.

## Tier 2: wrong behaviour that fails safe or over-asks

Nothing open. Closed on 2026-09-20: block insertion inside `describe()` groups (indentation-relative matching, with a group opener allowing a deeper first child), and the repo-to-local `--marketplace` switch now removes the GitHub entry from the shared settings.

## Tier 3: eval-suite coverage and privacy

- **A shapeless row survives next to its shaped twin.** Two causes, verified on the gov-data transcripts on 2026-09-24. First, Claude Code records some Edit results with `originalFile: null` (40 of the 134 Edit results there) although `oldString` and `newString` are present; `editShape` returns no shape at all in that case, so the edit lands as a shapeless row while another edit on the same file, recorded with its original, lands shaped. Second, the supersede rule in `mine()` filters only the existing rows, and the fresh batch is deduped by id alone, so a shapeless row mined in the same walk as its shaped sibling is appended straight back. After the 2026-09-24 mine, 28 `go`, 36 `none`, and 4 `php` shapeless rows sit beside a shaped sibling, and the "superseded" count reports rows that are still there. Closing it takes `editShape` classifying `replace` and `insert` from the two strings alone when the original is missing (only `append` and `insert-block` need it), the same key-based filter on the fresh batch before the append, and a re-mine.

Closed on 2026-09-24: the miner read a method added before a class-closing brace as `replace` because the anchor was split, not contained; `editShape` now asks whether the edit adds whole lines and leaves every existing line alone, and a re-mine refines such `replace` rows to `insert` or `insert-block`.

Closed on 2026-09-19: `smbclient -U user%pass` redaction, the cwd substitution at `:` `;` `,`, the sed `w` command as a write, `node --check` over `evals/`, PostToolUse twins for every mined edit-tool vector, and `doctor` checks for a stale workflow or a drifted owned-entries record.

## Tier 4: scope limits

What is left after 2026-09-19, each with the reason it stays open.

- **Block insertion covers JS/TS, Go, and PHP only.** Swift test files never qualify; additions there ask unless they are appends. PHP was added on 2026-09-24 on the evidence of the mined corpus (of 17 edits to existing `*Test.php` files, 14 added whole test methods and every one asked, because a PHP test class ends with `}` so the append rule can never match). After the change and a re-mine, 7 of the 11 asking PHP test-file rows pass as `insert-block`; the 3 `replace` rows left are genuine changes to an existing test, and the 1 shapeless row is the `originalFile: null` case below. Swift waits for a mined corpus to measure against. In PHP, a method added right after a property or trait `use` line still asks, since only a closed method, a comment, or the class opener counts as a boundary; a `#` line comment or a heredoc inside the added method fails the balance check and asks too.
- **Block detection assumes formatted code.** The column-0 heuristics treat an unindented line inside a test body as top-level code, so a stray `}` at column 0 could let an insertion through that should ask, and a template literal with column-0 content makes a legitimate block ask. Unbalanced text always falls to ask.
- **Shell functions and aliases hide the tool word.** `g() { git "$@"; }; g reset --hard` resolves to `g`. Simple same-command assignments (`G=git; $G …`) and `$(which git)` are resolved now; functions and aliases need shell emulation, which the guards do not attempt. Substitution happens only at the start of a segment, so a prefix before the variable (`sudo $G reset --hard`) is not resolved either. Used as the runner fixture's known-gap vector (`test/fixtures/evals/corpus/adversarial/git.jsonl`, `ts-000011`).
- **Path fragments inside scripts read as real paths.** A fragment like `root + "/cmd/exit_test.go"` inside a heredoc looks like an absolute path outside the project and does not ask. The conservative alternative, matching heredoc bodies as text, was measured against the mined corpus: 71 commands whose heredoc body merely mentions a test file (notes, commit bodies) would start asking. Left open on that evidence.
- **Windows is unit-tested with fakes only.** `shellFor` resolution, the abort message, and the doctor finding are covered by tests that simulate `win32`; nothing here has run on Windows. Also, `doctor` compares the workflow byte for byte, so a checkout with `core.autocrlf` would report it stale.
