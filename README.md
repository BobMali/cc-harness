# cc-harness

Config-driven guardrails and a one-command bootstrap for Claude Code projects. Zero dependencies; Node 18+.

**What it enforces, once `.claude/harness.json` exists in a project:**

| Guard | Event | Behaviour |
|---|---|---|
| test | before Write/Edit/Bash | prompts before an existing test file is edited, deleted, or rewritten by a command; running tests is free |
| commit | before Bash | denies `git commit` unless the subject matches the regex in `githooks/conventional-regex.txt`; rejects attribution trailers (configurable) |
| quality | after Write/Edit | runs the fast checks (typecheck, lint, format) and hands the failure back to Claude with "fix this before continuing" |
| git | before Bash | prompts before `reset --hard`, `checkout .` / `checkout -- <path>`, `restore .`, `clean -f`, `push --force`, `branch -D`, `stash drop`/`stash clear` |
| stop | when Claude wants to end a turn | if source or test files changed this session, runs the named checks and refuses to stop while they fail (bounded by `maxBlocks`) |
| preflight | session start | prints a status block: version, preset, active guards, skipped checks, findings |

A project without `.claude/harness.json` sees nothing.

The commit regex allows a one-character subject and rejects a trailing period; the subject may be at most 66 characters after the colon. The guard resolves the `-m "$(cat <<'EOF' … EOF\n)"` heredoc idiom Claude Code commonly writes, and passes any other `-m` value that still contains `$(` or a backtick straight through, deferring to the git `commit-msg` hook — the authoritative enforcer of both the regex and the trailer rule. For the same reason, `echo msg | git commit -F -` and a message file written earlier in the same command are invisible to the guard; the hook still catches them.

The stop gate arms only on edits made through Claude's Write/Edit tools. A source change made by a shell command (`sed -i`, a formatter, `git apply`) does not arm it; the quality gate does not see those either.

## Install

```sh
claude plugin marketplace add BobMali/cc-harness      # replace with your fork's owner/repo if you forked
claude plugin install cc-harness@cc-harness
```

## Bootstrap a project

Inside the project, in Claude Code:

```
/cc-harness:init
```

or from a terminal:

```sh
node ~/.claude/plugins/cache/cc-harness/cc-harness/*/bin/harness.mjs init --preset ts --scopes api,web
git config core.hooksPath githooks
```

`init` writes:

- `.claude/harness.json` — `{ "version": 1, "preset": "<preset>" }` for a shipped preset; for `--preset custom` a fuller skeleton with empty `project`, `commands`, `checks`, and `guards.stop.checks`, since there is no preset file to fill them in. Never overwritten without `--force`.
- `.claude/settings.json` — the plugin enabled, and a permission profile: read-only git (`status`, `diff`, `log`, `show`, `branch`) and the configured check commands are allowed; `git push`, `rm`, and the preset's write commands (e.g. `prettier --write`, `eslint --fix`) ask; `Read`/`Edit` of `**/.env`, `**/.env.*`, `**/*.pem`, `**/credentials.*`, `~/.ssh/**`, and `~/.gnupg/**` are denied.
- `.claude/settings.local.json` — only when `--marketplace` is a local path (the default inside this repo): the resolved marketplace entry, kept out of `settings.json` and appended to `.gitignore`. An `owner/repo` marketplace goes straight into `.claude/settings.json` instead.
- `CLAUDE.md` (or `CLAUDE.harness.md` beside an existing one).
- Five `.claude/rules/harness-*.md` files (testing, done, commits, models, harness). Never overwritten without `--force` for the regex file below; the rules themselves are regenerated freely by `sync-rules`.
- `githooks/commit-msg` and `githooks/conventional-regex.txt`. The regex file is never overwritten without `--force`.
- `.github/workflows/harness.yml`.

## Configure

`.claude/harness.json`, camelCase, every key optional on top of the preset:

```jsonc
{
  "version": 1,
  "preset": "ts",
  "project":  { "markerFile": "package.json", "sourceGlobs": [...], "testGlobs": [...], "ignoreGlobs": [...] },
  "commands": { "safe": [...], "write": [{ "cmd": "prettier", "whenFlags": ["--write", "-w"] }], "runnerWrappers": [...] },
  "checks":   [{ "name": "typecheck", "cmd": "node_modules/.bin/tsc --noEmit", "ifExists": "tsconfig.json", "fast": true }],
  "guards": {
    "test":      { "enabled": true },
    "commit":    { "enabled": true, "regexFile": "githooks/conventional-regex.txt", "rejectAttributionTrailers": true },
    "quality":   { "enabled": true, "scope": "fast" },
    "git":       { "enabled": true },
    "stop":      { "enabled": true, "checks": ["typecheck", "test"], "maxBlocks": 3 },
    "preflight": { "enabled": true }
  }
}
```

Disable a guard: `"guards": { "git": { "enabled": false } }`. Change the commit format: edit line 1 of `githooks/conventional-regex.txt` (keep the `# types:` / `# scopes:` lines for readable error messages). `guards.commit.rejectAttributionTrailers` only controls the Claude commit guard and the generated rule text — the git hook and CI enforce the trailer check independently via the `CC_HARNESS_REJECT_TRAILERS` environment variable (default on); set it to `0` alongside the config key if you want both to agree. Full key reference: [docs/presets.md](docs/presets.md).

## Presets

| preset | marker | checks |
|---|---|---|
| `ts` | `package.json` | tsc, eslint, prettier (fast); vitest or jest (stop gate) |
| `custom` | none | you write the config |

Writing another preset: [docs/presets.md](docs/presets.md).

## Commands

```
harness hook <event>       # used by hooks.json; reads hook JSON on stdin
harness init [...]         # bootstrap; see /cc-harness:init
harness doctor             # explain the install state (exit 1 only on errors; warnings exit 0)
harness sync-rules         # refresh harness-*.md rules and the git hook after a plugin update
harness version            # print the plugin version
```

## Develop

```sh
node --test test/*.test.mjs
claude plugin validate plugins/cc-harness --strict
```
