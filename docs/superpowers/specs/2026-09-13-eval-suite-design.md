# cc-harness eval suite design

## Context

The unit tests prove each guard against the vectors someone thought of. The
Task 1 and Task 3 reviews of the build found ten parser bypasses and false
denies by trying realistic commands the tests never held. This suite makes
that reviewer's work permanent and mechanical: a large corpus of real and
adversarial tool payloads, evaluated offline through the production guard
path, with a decision baseline that fails the build when a decision changes.

It measures guard decisions only. Whether Claude obeys the rendered rules is
a live-session question; `claude plugin eval` exists for that and is a
possible later tier, not this suite.

### Decisions made with the user (2026-09-13)

| Topic | Decision |
|---|---|
| Target | Guard decisions on a command corpus; offline, deterministic, free |
| Sources | Mined from local Claude Code transcripts, plus a hand-authored adversarial set |
| Labelling | Mined vectors: snapshot the current decision, review diffs, accept with `--update`. Adversarial vectors: true expectations from the spec, never auto-updated |
| Privacy | Corpus committed to the public repo after redaction and a manual review pass |
| Config | Each vector is evaluated under a config for its origin language (ts uses the shipped preset; go, php, swift, none are eval-only configs) |
| Runner | In-process Node script with a decision matrix, snapshot diffs, and a sampled `--via cli` mode |

### When it runs

1. Locally, before committing any change to `lib/shell.mjs`, `lib/glob.mjs`,
   `lib/config.mjs`, or a guard. Seconds, not minutes.
2. In CI on every push, after the unit tests, as a required check.
3. On demand after re-mining, to see how the current guards judge commands
   they have never seen.

## 1. Layout and vector format

```
evals/
├── README.md                     # run, filter, read a mismatch, accept, add a vector, re-mine, redaction guarantees
├── configs/
│   ├── ts.json                   # {"version":1,"preset":"ts"} — resolves through the shipped preset
│   ├── go.json, php.json, swift.json   # eval-only full configs
│   └── none.json                 # {"version":1,"preset":"custom"} — no globs; guards mostly silent
├── corpus/
│   ├── mined/<lang>.jsonl        # redacted, snapshot expectations
│   └── adversarial/<guard>.jsonl # hand-written, true expectations, one file per guard
├── run.mjs
└── mine.mjs
```

One vector per JSONL line:

```jsonc
{
  "id": "go-7f3a2c",                 // lang + first 6 hex of sha1(lang|tool|normalised payload)
  "lang": "go",                      // selects configs/<lang>.json
  "event": "PreToolUse",             // PreToolUse | PostToolUse
  "tool": "Bash",                    // Bash | Write | Edit | MultiEdit
  "input": { "command": "go test ./... && git commit -m \"feat(hash): add sha3\"" },
  "fixture": { "exists": ["internal/hash/hash_test.go"] },
  "expected": { "kind": "pass" },    // pass | ask | deny | block; optional "guard"; optional "known_gap": true
  "source": "mined",                 // mined | adversarial
  "note": "ldsum 2026-08"            // mined: project dir name + month; adversarial: bypass class
}
```

- Edit-tool inputs carry `file_path` relative to the project root; the runner
  resolves it against the temp project.
- `expected` records the winning decision kind and the guard that produced it.
  Reason text is never snapshotted, so wording changes never fail the suite.
- `expected: null` marks an unlabelled mined vector.
- `known_gap: true` marks an adversarial vector whose expectation the spec
  wants but the code does not yet meet. The runner reports these separately
  and does not fail on them; the file doubles as the bypass backlog. Closing a
  gap means deleting the flag.

## 2. Runner

`node evals/run.mjs [--lang go,ts] [--source mined|adversarial] [--guard commit]
[--update] [--via cli --sample 100] [--json <path>]`

Per language, once: create a temp project, copy `configs/<lang>.json` to
`.claude/harness.json`, create the config's `markerFile`, and write a standard
regex file at `githooks/conventional-regex.txt` (types
`feat fix docs test refactor build ci chore`, no scopes) so commit-guard
vectors evaluate identically in every language. Load the config through
`loadConfig` so preset merging and validation follow the production path.

Per vector:

1. Create the `fixture.exists` files as empty files inside the temp project.
2. Build the hook input `{ hook_event_name, tool_name, tool_input, session_id: 'eval', cwd }`
   with `file_path` resolved against the temp project.
3. Run the dispatcher's guard loop for the event with `exec` stubbed to
   `{ status: 0, output: '' }` and `dataDir` set to a per-run temp dir.
   PostToolUse vectors therefore assert whether the quality gate would arm,
   not what the checks say.
4. Record `{ kind, guard }` from `pickDecision`; `null` is `pass`.
5. Remove the fixture files.
6. Compare with `expected`.

The guard loop is exported from `lib/cli.mjs` as `evaluateGuards(event, ctx)`
so the runner and `runHook` share one code path; that export is the only
production change this suite needs.

`--via cli --sample N` additionally spawns `bin/harness.mjs hook <event>` for a
random sample of N vectors with `CLAUDE_PROJECT_DIR` set to the temp project
and asserts the stdout JSON envelope maps to the same decision kind.

Report:

- A matrix per language: rows per guard, columns pass / ask / deny / block.
- A mismatch list: id, command or path, expected, actual, and the actual
  reason text as an aid.
- A known-gaps list.
- A summary line: total, matched, mismatched, unlabelled, known gaps, elapsed.
- `--json` writes the same data.

Exit codes: 0 when every labelled vector matches; 1 on any mismatch; 2 when
unlabelled vectors exist and `--update` was not passed, so a freshly mined
batch cannot pass by accident. `--update` rewrites `expected` for mined vectors
only and refuses to touch adversarial files.

Performance target: 4,000 vectors under ten seconds in-process.

## 3. Miner and redaction

`node evals/mine.mjs [--from ~/.claude/projects] [--out evals/corpus/mined]`

Extraction: every session file including subagent side-chains. For each
record whose message content holds a `tool_use` block named Bash, Write, Edit,
or MultiEdit, take the tool name, the input, and the record's `cwd`.

Language: marker files checked in `cwd` on disk at mining time. `go.mod` → go;
`composer.json` → php; `package.json` → ts; `Package.swift` or a
`*.xcodeproj` → swift; otherwise or when the directory no longer exists → none.

Fixture derivation: Edit and MultiEdit imply the file existed → listed in
`fixture.exists`. Write is listed only if an earlier Write or Edit in the same
session touched the same path. Bash vectors get no fixture.

Redaction, in order:

1. Replace the `cwd` prefix with `.` inside commands and paths; then any
   remaining `/Users/<name>` or `/home/<name>` with `~`.
2. Drop the vector if the payload matches any of: `token`, `secret`,
   `password`, `api[_-]?key`, `Authorization:`, a URL with `user:pass@`,
   `-----BEGIN`, or a bare run of 32+ hex or base64 characters.
3. Drop vectors that reference `.ssh`, `.gnupg`, `.env`, or `.npmrc`.
4. Truncate commands over 2,000 characters. Heredoc bodies over 40 lines keep
   the first and last five lines with a `# … <n> lines elided …` marker line
   between; the guards read only the marker and terminator.

Dedupe and identity: normalise whitespace; key on language, tool, and the
normalised payload; id = lang prefix + first six hex of SHA-1 over the key.
Re-mining produces stable ids and only appends new lines with
`expected: null`.

Never written: `cwd`, session id, timestamps, tool results, surrounding
conversation. `note` holds the project directory name and the month.

Review before the first commit: the miner prints a count per language and the
fifty longest vectors; the corpus is committed only after a human pass.

## 4. Adversarial set

`evals/corpus/adversarial/<guard>.jsonl`, hand-written, `expected` from the
spec. Initial coverage:

- **test**: quoting, wrappers (`npx`, `pnpm exec`, `npm run`, `yarn workspace`),
  heredoc redirect into a test path, attached redirect (`echo x>a.test.ts`),
  interpreter one-liners (`node -e`, `python3 -c`), `git -C` with safe and
  unsafe subcommands, ignored paths, new vs existing test files, paths outside
  the project.
- **commit**: `-m` forms (attached, multiple, `--message=`), `-F file`,
  `-F -` heredoc, the `$(cat <<'EOF' … )` idiom, `-am`, `--amend` with and
  without a message, `git -C` and `--git-dir` globals, `--no-verify`, trailers
  in every casing, subjects at 66 and 67 characters, `\r\n` endings, a decoy
  heredoc earlier in the command.
- **git**: every destructive form in the spec plus near-misses
  (`--force-with-lease`, `reset --soft`, `clean -n`, `branch -d`), refspec
  force (`push origin +main`), `--delete --force`, `bash -c "git reset --hard"`,
  `checkout <file>` vs `checkout .`.
- **quality** (PostToolUse): source paths, test paths, ignored paths, a path
  outside the project, `MultiEdit`, a missing `file_path`.

Vectors for decisions the build ledger deferred are added with
`known_gap: true`.

## 5. CI, dogfood, docs

- `.github/workflows/harness.yml` in this repo runs
  `node evals/run.mjs --json evals/results.json` after the unit tests and
  uploads the JSON as an artefact.
- The dogfood `.claude/harness.json` adds
  `{ "name": "evals", "cmd": "node evals/run.mjs" }` as a non-fast check named
  in the stop gate.
- `mine.mjs` never runs in CI; it needs local transcripts.
- `evals/README.md` documents: run, filter, read a mismatch, accept, add an
  adversarial vector, re-mine, and the redaction guarantees.

## Testing the suite itself

`test/evals.test.mjs` covers: the redactor (each rule with a positive and a
negative), id stability, dedupe, fixture derivation from a synthetic
transcript, exit codes 0/1/2, `--update` refusing adversarial files, and
`known_gap` not failing the run. The runner's decision path is the production
path, so its correctness rests on the guard tests.

## Out of scope

Live-session evals; grading Claude's compliance with rules; check execution;
the stop gate's marker lifecycle; stdout envelope coverage beyond the sampled
`--via cli` mode.
