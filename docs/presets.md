# Writing a cc-harness preset

A preset is a JSON file in `plugins/cc-harness/presets/<name>.json`. It is merged under the consumer's `.claude/harness.json` (consumer keys win), which is itself merged under the built-in defaults. `preset: "custom"` means no preset file. Every key is optional.

The shipped `ts.json` is the worked example; each section below quotes it.

## project

| key | meaning | ts.json |
|---|---|---|
| `markerFile` | file at the project root that must exist for any guard to run; keeps a globally enabled plugin out of unrelated repos | `package.json` |
| `sourceGlobs` | edits to these arm the quality gate and mark the session dirty for the stop gate | `**/*.ts`, `**/*.tsx`, `**/*.js`, … |
| `testGlobs` | edits to existing files matching these prompt (the test guard); a match also arms the quality gate and the stop-gate dirty flag, same as `sourceGlobs` | `**/*.test.*`, `**/*.spec.*`, `**/__tests__/**` |
| `ignoreGlobs` | checked first; a match disarms every path-based guard | default: node_modules, dist, build, .git |

Globs: `*` never crosses `/`; `**/` matches zero or more directories; a glob without `/` is also tried against the basename.

An empty `testGlobs` disables the test guard entirely, not just its matching.

## commands

| key | meaning | ts.json |
|---|---|---|
| `safe` | tool words that may mention a test file without prompting (test runners, linters in check mode). Merged with the built-in read-only list (`cat`, `grep`, `ls`, …). `git` is handled specially: only an allow-listed set of subcommands (`status diff log show blame grep ls-files rev-parse branch remote add commit tag describe`) is safe — the list favours commands that don't change a file's content, not strictly read-only ones. | `node tsc vitest jest eslint prettier tsx ts-node` |
| `write` | tool words that rewrite files. `whenFlags`: a write only when one of the flags is present. `unlessFlags`: a write unless one is present. Neither: always a write. Interpreters go here with their eval flags so `node -e "...writeFileSync('x.test.ts')"` prompts. | `prettier --write/-w`, `eslint --fix`, `node -e/--eval/-p/--print` |
| `runnerWrappers` | words whose next word is the real tool | default: `npx pnpm yarn bunx bun npm` |

The tool word is the basename of the first non-assignment token (`vendor/bin/phpunit` → `phpunit`; `FOO=1 env node` → `node`). After a wrapper, `run`, `exec`, `--`, and similar are skipped, so `npm run lint:fix` resolves to `lint:fix` (unknown → prompts) and `npm test` to `test` (built-in safe). Commands inside `$( )` or backticks are not inspected; the guard sees only top-level segments.

## checks

Ordered, named commands run via `/bin/sh -c` with the project root as cwd.

| key | meaning |
|---|---|
| `name` | unique; referenced by `guards.stop.checks` and shown in failures |
| `cmd` | the command. Invoke tools by path (`node_modules/.bin/tsc`), not through `npx`, which may hit the network. Use non-watch, non-interactive modes. |
| `ifExists` | skip the check when this path is absent (a tool binary or a config file) |
| `fast` | `true` marks it for the after-every-edit quality gate; leave slow suites unmarked and name them in the stop gate instead |

## guards

Each guard has `enabled`. Extra keys: `commit.regexFile`, `commit.rejectAttributionTrailers`, `quality.scope` (`fast` or `all`), `stop.checks` (names), `stop.maxBlocks` (0–7).

`commit.rejectAttributionTrailers` only controls the Claude commit guard (and the trailer bullet in the generated `harness-commits.md` rule). The git `commit-msg` hook and CI enforce the trailer check independently, reading the `CC_HARNESS_REJECT_TRAILERS` environment variable (default `1`, i.e. reject); set `CC_HARNESS_REJECT_TRAILERS=0` in the hook's environment to keep the two in sync when you disable the config key.

## ci (preset only)

`ci.setupSteps` is a list of GitHub Actions step objects rendered before the check steps in `.github/workflows/harness.yml`. Guards ignore it.

## Checklist for a new preset

1. Copy `ts.json`, change every value, delete what does not apply.
2. Run `node --test test/*.test.mjs`; `presets.test.mjs` validates every preset file.
3. Bootstrap a scratch project with `--preset <name>` and confirm: editing an existing test prompts, running the test suite does not, a bad commit message is denied, breaking a fast check returns its output.
4. Add a row to the README's preset table.
