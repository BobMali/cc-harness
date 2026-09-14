# cc-harness design

## Context

`~/projects/ai/cc-harness-v1` is empty (no git, no files). The goal is a
harness that anyone can add to a Claude Code project with one install command
and one bootstrap command. It was brainstormed from zero on 2026-09-12; an
earlier plan extracted from ldsum was explicitly set aside.

### Decisions made with the user

| Topic | Decision |
|---|---|
| Audience | Public, anyone |
| Core promise | Enforce guardrails, ship workflow-agnostic conventions, bootstrap a project. Not domain expertise. |
| Delivery | Plugin via marketplace; consumers pull updates. Only project-specific files rendered into the repo. |
| Languages | Config-driven guards. One preset (TypeScript/JS) plus a documented recipe for writing others. |
| Workflow | Agnostic. No spec/plan/execute skills. Ships model policy, done criteria, commit rules, testing rules as conventions. |
| Guards | Test guard, commit guard, quality gate, destructive git guard, Stop gate, SessionStart preflight, permission profile. Not: subagent guard. |
| Bootstrap | A skill drives a bundled script; the script also runs standalone. |
| Rendered into repo | settings, harness config, CLAUDE.md template, `.claude/rules/` (harness-owned conventions), git commit-msg hook, CI workflow. Commit regex user-overridable. |
| CLAUDE.md vs rules | Project-specific content in CLAUDE.md; harness conventions as rules files that can be re-synced. |
| Hook runtime | Node.js, zero dependencies |
| Architecture | Single CLI entry point (`bin/harness.mjs`) with subcommands; one repo is both marketplace and plugin |
| Version control | `git init` now; commit per task |

---

### Facts verified against the Claude Code docs (2026-09-12)

- PreToolUse output: `hookSpecificOutput.{hookEventName,permissionDecision(allow|deny|ask|defer),permissionDecisionReason}`; exit 2 + stderr blocks. Precedence deny > defer > ask > allow.
- PostToolUse: cannot block the call; `{"decision":"block","reason"}` (top-level) puts reason next to the tool result; exit 2 stderr also reaches Claude.
- Stop: stdin has `stop_hook_active`, `last_assistant_message`; `{"decision":"block","reason"}` keeps Claude working; Claude Code force-ends after 8 consecutive blocks.
- SessionStart: `source` in startup|resume|clear|compact|fork; plain stdout is added to context; `CLAUDE_ENV_FILE` lets the hook persist env vars.
- Plugin hooks: `hooks/hooks.json`; `${CLAUDE_PLUGIN_ROOT}` substituted; process gets `CLAUDE_PROJECT_DIR`, `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`; default timeout 600 s; `Write|Edit|MultiEdit` is an exact-match list.
- Plugin hooks and project settings hooks both run; hooks run inside subagents.
- Marketplace: `claude plugin marketplace add owner/repo` (no `github:` prefix); `claude plugin install name@marketplace`; project settings `extraKnownMarketplaces` + `enabledPlugins` register but do not auto-install; each user runs the install command.
- `plugin.json`: only `name` required. Skills at `skills/<name>/SKILL.md`, invoked `/cc-harness:<name>`.
- `.claude/rules/*.md` with optional `paths:` frontmatter is documented. **Plugins cannot ship rules**; they must be rendered into the consumer repo.
- Permission lists (allow/ask/deny) merge across settings files; `settings.local.json` outranks `settings.json`.
- `claude plugin validate <path> --strict` exists.

## Design

### 1. Architecture and repo layout

One repo `cc-harness` is both marketplace and single plugin. One Node entry point.

```
cc-harness/
├── .claude-plugin/marketplace.json     # name: cc-harness, plugins: [./plugins/cc-harness]
├── plugins/cc-harness/
│   ├── .claude-plugin/plugin.json
│   ├── hooks/hooks.json                # every entry: node "${CLAUDE_PLUGIN_ROOT}/bin/harness.mjs" hook <event>
│   ├── bin/harness.mjs                 # CLI: hook <event> | init | doctor | sync-rules
│   ├── lib/
│   │   ├── config.mjs                  # load + validate .claude/harness.json, apply preset defaults
│   │   ├── hook-io.mjs                 # read stdin JSON, emit ask/deny/block/context JSON
│   │   ├── shell.mjs                   # split command lines, resolve tool word, redirect targets
│   │   ├── glob.mjs                    # minimal glob → regex, no deps
│   │   ├── guards/{test,commit,quality,git,stop,preflight}.mjs
│   │   └── render.mjs                  # {{KEY}} template rendering, file merging
│   ├── presets/ts.json
│   ├── templates/                      # CLAUDE.md, rules/*.md, commit-msg, ci.yml, settings fragments
│   ├── skills/init/SKILL.md            # /cc-harness:init
│   └── skills/doctor/SKILL.md          # /cc-harness:doctor
├── docs/presets.md                     # recipe for writing a preset
├── test/                               # node:test, one file per lib module and per guard
├── CLAUDE.md, .claude/                 # dogfood
└── README.md
```

Runtime flow: hook fires → hooks.json runs the CLI with the event name → CLI reads stdin JSON, loads `.claude/harness.json`, dispatches to the guards for that event, prints one JSON decision. **No config file → every hook exits 0 silently.**

Consumer prerequisites: Node 18+, git, Claude Code. No npm install, no build.

### 2. Config schema `.claude/harness.json` (camelCase throughout)

Presence of the file turns the harness on. Preset defaults are merged under it; consumer keys win.

```jsonc
{
  "version": 1,                       // schema version; preflight warns on mismatch
  "preset": "ts",                     // or "custom"
  "project": {
    "markerFile": "package.json",     // guards stand down if absent from project root
    "sourceGlobs": ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx", "**/*.mjs", "**/*.cjs"],
    "testGlobs":   ["**/*.test.*", "**/*.spec.*", "**/__tests__/**"],
    "ignoreGlobs": ["**/node_modules/**", "**/dist/**", "**/build/**", "**/.git/**"]
  },
  "commands": {
    "safe":  ["node", "tsc", "vitest", "jest", "eslint", "prettier"],
    "write": [{"cmd": "prettier", "whenFlags": ["--write", "-w"]}, {"cmd": "eslint", "whenFlags": ["--fix"]}],
    "runnerWrappers": ["npx", "pnpm", "yarn", "bunx", "bun", "npm"]
  },
  "checks": [                         // ordered, named; reused by quality gate, stop gate, CI, doctor
    {"name": "typecheck", "cmd": "node_modules/.bin/tsc --noEmit",      "ifExists": "tsconfig.json",            "fast": true},
    {"name": "lint",      "cmd": "node_modules/.bin/eslint .",          "ifExists": "node_modules/.bin/eslint",   "fast": true},
    {"name": "format",    "cmd": "node_modules/.bin/prettier --check .","ifExists": "node_modules/.bin/prettier", "fast": true},
    {"name": "test",      "cmd": "node_modules/.bin/vitest run",        "ifExists": "node_modules/.bin/vitest"}
  ],
  "guards": {
    "test":      {"enabled": true},
    "commit":    {"enabled": true, "regexFile": "githooks/conventional-regex.txt", "rejectAttributionTrailers": true},
    "quality":   {"enabled": true, "scope": "fast"},          // "fast" | "all"
    "git":       {"enabled": true},
    "stop":      {"enabled": true, "checks": ["typecheck", "test"], "maxBlocks": 3},
    "preflight": {"enabled": true}
  }
}
```

- Globs are `**`-aware (`*` never crosses `/`), implemented once in `lib/glob.mjs`.
- `checks[].fast` tags what the per-edit quality gate runs; the stop gate names its checks explicitly.
- `write[]` entries also accept `unlessFlags` (e.g. a formatter that is read-only with `--check`).
- Presets are plain JSON files in `presets/`; `docs/presets.md` walks every key using `ts.json` as the worked example.
- Built-in safe list (always merged): `cat head tail less grep rg wc ls stat file realpath basename dirname sort uniq cut tr diff cmp shasum echo printf true test`.
- `guards.commit.regexFile` is not just read by the commit guard: `init` and `sync-rules` render it into the git `commit-msg` hook and into the CI commits job, so a custom path stays wired end to end.

### 3. Guard behaviour

Shared preamble: read stdin JSON, project root = `CLAUDE_PROJECT_DIR`, load config. No config → exit 0, no output. Marker file absent → every guard stands down except the SessionStart preflight, which reports it. Guard disabled → exit 0, no output. PreToolUse answers with `hookSpecificOutput.permissionDecision`; PostToolUse and Stop with top-level `decision:"block"`.

| Guard | Event / matcher | Behaviour | Outcome |
|---|---|---|---|
| Test | PreToolUse: `Write\|Edit\|MultiEdit` and `Bash` | Edit tools: target matches `testGlobs` and exists → ask; new test files pass. Bash: split on `; \| && \|\|`, resolve tool word through `runnerWrappers`, ask if segment mentions a test-glob path and tool word not safe, or is a `write` command, or a redirect targets a test path. | `ask`, reason names the file. Running tests never prompts. |
| Commit | PreToolUse: `Bash` | `git commit` segments; message from `-m`, `-F`, heredoc. Line 1 must match line 1 of `regexFile`. `rejectAttributionTrailers` → reject `Co-Authored-By`, `Claude-Session`, `Generated with` lines. `--amend` without message passes. | `deny` with expected format; types/scopes parsed from `# types:` / `# scopes:` comment lines in the regex file. |
| Quality | PostToolUse: `Write\|Edit\|MultiEdit` | Edited path matches `sourceGlobs` or `testGlobs` → write the session dirty marker (for the stop gate), then run checks in scope (`fast` default) in order, stop at first failure, output truncated to last 60 lines. Marker is written even when `guards.quality.enabled` is false, so the stop gate still works alone. | `decision:"block"` with check name, cmd, output, "Fix this before continuing. Do not start new work." All pass → silent. |
| Git | PreToolUse: `Bash` | Fixed list: `reset --hard`, `checkout .`/`checkout -- <path>`, `restore .`, `clean -f`, `push --force`/`-f` (not `--force-with-lease`), `branch -D`, `stash drop`/`stash clear`. | `ask` naming the command and what it discards. |
| Stop | Stop | Read the dirty marker `CLAUDE_PLUGIN_DATA/sessions/<session_id>.json` that the quality gate writes whenever a source/test file is edited. No marker → exit 0. Else run `guards.stop.checks` by name. On pass: clear the marker, exit 0. On fail: increment the marker's `blocks` counter and block while `blocks <= guards.stop.maxBlocks` (default 3, must stay below Claude Code's hard cap of 8); past the cap, let the turn end with a one-line warning in the reason. Does **not** skip on `stop_hook_active`; re-checking is the point. | `decision:"block"` with failing output. Claude keeps working until the named checks pass or the cap is hit. |
| Preflight | SessionStart (all sources) | Runs doctor: node version, git, config parses, version match, regex file exists, `core.hooksPath=githooks`, rules present and current, each `ifExists` target. On `source: startup` also prunes session markers older than 7 days. | Five-line status block on stdout → context. Never fails the session. |

Cross-cutting: unparseable input → unknown → **ask** (test, git guards). Commit guard is the only `deny`, because git hook + CI enforce the same rule anyway.

Session state: everything written to `CLAUDE_PLUGIN_DATA` is keyed by `session_id` (present on every hook's stdin), because that directory is per-plugin, not per-session or per-project, and concurrent sessions must not clobber each other. No git snapshots: a mid-session commit or a compaction restart would defeat them.

`hooks.json` has one entry per event with a combined exact-match matcher (`PreToolUse` → `Bash|Write|Edit|MultiEdit`; `PostToolUse` → `Write|Edit|MultiEdit`; `Stop`; `SessionStart`), so one node process handles every guard for that event and dispatches internally.


### 4. Bootstrap, rendered files, rules, permissions

Consumer install path:
```
claude plugin marketplace add <owner>/cc-harness
claude plugin install cc-harness@cc-harness
/cc-harness:init        # or: node <plugin-root>/bin/harness.mjs init --preset ts
```

`init` flags: `--preset ts|custom`, `--types a,b`, `--scopes a,b`, `--force`, `--dry-run`. Per-file behaviour when the file already exists:

| File | Existing-file behaviour |
|---|---|
| `.claude/harness.json` | refuse without `--force` |
| `.claude/settings.json` | deep-merge: add `enabledPlugins`, `extraKnownMarketplaces`; union permission lists; touch nothing else |
| `CLAUDE.md` | write `CLAUDE.harness.md` beside it, print merge instructions |
| `.claude/rules/harness-*.md` | overwrite (harness-owned, prefix marks ownership) |
| `githooks/conventional-regex.txt` | refuse without `--force` (user may have edited) |
| `githooks/commit-msg`, `.github/workflows/harness.yml` | overwrite |

Rules rendered (`.claude/rules/harness-<name>.md`, no `paths:` scoping in v1): `testing`, `done`, `commits`, `models` (subagent model-assignment policy from `~/.claude/CLAUDE.md`: implementer tiers, reviewers on opus; the advisor paragraph is phrased conditionally, "if your setup has a reviewer or advisor tool", since public consumers may not have one; anecdote section dropped), `harness` (what is active, how to disable a guard). Each has a generated header with the plugin version stamp.

`sync-rules`: re-renders `harness-*` rules and `githooks/commit-msg` from the installed plugin. Preflight reports staleness by comparing the header stamp to the plugin version.

CLAUDE.md template: project description, layout, commands, sandbox notes, one pointer to `.claude/rules/`. Placeholders `{{PROJECT_NAME}}`, `{{COMMANDS}}`.

Permission profile merged into `.claude/settings.json`: allow read-only git + the preset's check commands; ask `git push`, `rm`, every `write` command; deny Read/Edit on `.env*`, `.ssh`, `.gnupg`, `*.pem`, `credentials.*`. Lists merge, so this only adds.

Skills: `/cc-harness:init` (detect preset from marker files, ask types/scopes, run the script with sandbox disabled or instruct `!`), `/cc-harness:doctor`.

### 5. Testing, dogfooding, release

**Testing** (`node --test test/`, zero deps):
- Unit per lib module: glob, shell segmentation + tool word, config merge with preset, render, settings deep-merge.
- Guards are pure functions `(hookInput, config, fs) → decision`; tests feed JSON and assert the decision. Fixture helper builds a temp project (config + marker file) for disk-touching cases.
- Integration: spawn `bin/harness.mjs hook <event>` with stdin JSON, assert stdout + exit code. `init` renders into a temp dir, asserts exact file set, second run asserts refuse/overwrite rules.
- Vectors carried from ldsum experience: `git commit -m "update code"` → deny; `sed -i ... x.test.ts` → ask; `vitest run x.test.ts` → pass; `node -e "...writeFileSync('x.test.ts'...)"` → ask; attribution trailer → deny.

**Dogfooding**: this repo runs the harness with a `custom` config (source `plugins/**/*.mjs`, tests `test/**`, checks `node --check` and `node --test`). Its rules, git hook, and CI come from its own `init`.

**Release**: version in `plugin.json`, matching git tags. CI runs `claude plugin validate --strict` + tests. README: install, init, disabling a guard, pointer to `docs/presets.md`.

---

## Risks

| Risk | Mitigation |
|---|---|
| Globally enabled plugin fires in unrelated projects | Config absent → silent exit 0; first test in T1 |
| Stop gate loops forever | `guards.stop.maxBlocks` (default 3) per session marker; Claude Code's 8-block cap is the backstop; no marker → no check |
| Stop gate misses edits | Marker written by PostToolUse on every source/test edit, independent of git state and of compaction/resume restarts |
| Quality gate cost on every edit | `fast` scope default; `ifExists` skips; 600 s timeout |
| Shell splitting inside quoted strings | Documented limitation; unknown → ask keeps it safe |
| Rules cannot ship in a plugin | Rendered by `init`, refreshed by `sync-rules`, staleness reported by preflight |
| Node absent on a consumer machine | Documented prerequisite; hook failure surfaces as a Claude Code hook error, not silent |

