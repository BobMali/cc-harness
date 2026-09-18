---
name: init
description: Bootstrap cc-harness in the current project (config, settings, rules, git hook, CI) or refresh the harness-owned rules after a plugin update. Use when the user says "set up cc-harness", "init the harness", "install the guardrails", or "sync the harness rules".
---

# cc-harness init

## Detect the preset

Look at the project root:
- `package.json` present → preset `ts`
- otherwise → preset `custom` (the user fills in globs and checks by hand; point them at "Writing a cc-harness preset", the README's Presets section, or docs/presets.md in the cc-harness repository)

Tell the user which preset you detected and why. Let them override.

## Ask two things, once

1. Commit scopes as a comma-separated list (for example `api,web,ci`). Empty means any scope matching lower-case letters, digits, and hyphens (`[a-z0-9-]+`) is accepted.
2. Whether attribution trailers (Co-Authored-By, Claude-Session, "Generated with") should be rejected. Default yes. If no:
   - To allow attribution trailers, set `guards.commit.rejectAttributionTrailers` to `false` in `.claude/harness.json` and run `harness sync-rules` (or `init --force`); that regenerates the git hook, the `harness-commits.md` rule, and the CI env so all three enforcers agree. The `CC_HARNESS_REJECT_TRAILERS` environment variable still overrides the hook per invocation if someone needs a one-off.

Do not ask about types unless the user brings it up; the default set is `feat fix docs test refactor perf build ci chore revert` (`--types` overrides it).

## Run the installer

Always dry-run first and show the output:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/harness.mjs" init --target "$CLAUDE_PROJECT_DIR" --preset <preset> --scopes <scopes> --dry-run
```

Omit `--scopes` entirely when the user gave none — passing `--scopes` with an empty value makes the next flag get swallowed as the scopes value, since the installer just reads whatever token follows the flag.

Then run it for real without `--dry-run`. The installer writes into `.claude/`, which the Bash sandbox may deny; if the command fails with "Operation not permitted", first ask the user to run it themselves by typing `!` followed by the same command, or fall back to running it with the sandbox disabled.

If the installer refuses because `.claude/harness.json` or the regex file exists, do **not** add `--force` on your own. Show the refusal and ask.

A local `--marketplace` path (the default when running from inside this repo, or any directory you pass) is resolved against the current working directory and written to `.claude/settings.local.json`, whose path (`.claude/settings.local.json`) is then appended as a line to `.gitignore`; an `owner/repo` marketplace instead goes into the shared `.claude/settings.json` and touches no `.gitignore`. Mention this if the user asks why two settings files changed.

## Refresh after a plugin update

When the session preflight says rules are stale, run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/harness.mjs" sync-rules --target "$CLAUDE_PROJECT_DIR"
node "${CLAUDE_PLUGIN_ROOT}/bin/harness.mjs" sync-ci --target "$CLAUDE_PROJECT_DIR"      # when checks or the ci block in harness.json changed
```

If `githooks/conventional-regex.txt` has no `# types:` line, `sync-rules` warns on stderr and points the regenerated commits rule at the regex file itself instead of listing types inline — that is expected when the file was hand-edited.

## Finish

Relay the installer's numbered next steps verbatim (hooksPath, marketplace add, plugin install, CLAUDE.md placeholders). Then run `/cc-harness:doctor`.
