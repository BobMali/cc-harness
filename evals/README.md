# cc-harness evals

An offline corpus of tool payloads evaluated through the production guard path. Deterministic, no model calls, seconds per run.

## Run

The shipped corpus is adversarial-only and `ts`-only until `mine.mjs` has been run, so `--source mined` and `--lang go` (or `php`/`swift`) error with "no vectors selected" until then.

    node evals/run.mjs                      # everything; exit 0 clean, 1 mismatch, 2 unlabelled vectors
    node evals/run.mjs --lang ts,go         # filter by language
    node evals/run.mjs --source adversarial # or mined
    node evals/run.mjs --guard commit
    node evals/run.mjs --json out.json
    node evals/run.mjs --via cli --sample 100   # also spawn the real binary for a sample and compare envelopes

## Read a mismatch

    ts-7f3a2c  Bash  "sed -i '' 's/a/b/' src/a.test.ts"
        expected ask/test  actual pass
        reason: -

`expected` is what the corpus recorded; `actual` is what the guards decide now. For a mined vector, decide whether the change is an improvement; if so accept it with `--update`. For an adversarial vector the expectation is the spec: fix the code.

## Accept

    node evals/run.mjs --update   # rewrites expected for mined vectors only

## Add an adversarial vector

Append a line to `evals/corpus/adversarial/<guard>.jsonl`. Compute the id with `vectorId(lang, event, tool, input, fixtureExists)` from `evals/lib/corpus.mjs`. Set `expected` from the spec. If the current code gets it wrong and the gap is accepted for now, add `"known_gap": true`; the runner reports it without failing, and fails once the gap closes so the flag gets removed.

A vector for a tool call with a missing `file_path` is unrepresentable in this format (`validateVector` requires a string); that guard branch is covered by unit tests only.

## Known gaps

Five vectors in the adversarial corpus are currently marked `known_gap: true`:

- `bash -c "git reset --hard"` — a shell wrapper hides the `git` word from the git guard.
- `../outside.ts` (PostToolUse Edit) — a path outside the project still arms the quality gate.
- `yarn workspace app vitest run src/a.test.ts` — wrapper flags resolve to the wrong tool word, so the test guard over-asks instead of passing.
- `rm node_modules/pkg/a.test.js` — the test guard's Bash arm ignores `ignoreGlobs`.
- `rm ../outside.test.ts` — a path outside the project is not recognized as out of scope by the test guard.

See `docs/followups.md` for the fix each one needs.

## Re-mine

    node evals/mine.mjs                    # reads ~/.claude/projects, appends new vectors with expected: null
    node evals/run.mjs --update            # label them with current decisions

Review the miner's "longest vectors" list before committing.

## Redaction guarantees

The miner writes only the command (Bash) or the file path (edit tools), the language, and a fixture list. Absolute paths under the project become `.`; home directories become `~`. Vectors mentioning tokens, secrets, passwords, API keys, authorization headers, credentialed URLs, PEM blocks, or 32+ character hex/base64 runs are dropped, as are vectors touching `.ssh`, `.gnupg`, `.env`, or `.npmrc`. Heredoc bodies over 40 lines are elided; commands over 2,000 characters are truncated. Edit contents, tool results, session ids, and timestamps are never written.

## Languages

`evals/configs/<lang>.json` is the config each vector is evaluated under. `ts` resolves through the shipped preset; `go`, `php`, `swift` are eval-only configs and a dry run for future presets; `none` is an empty project.
