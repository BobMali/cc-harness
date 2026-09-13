# CLAUDE.md

This file provides guidance to Claude Code when working in this repository.
Conventions enforced by the cc-harness plugin live in `.claude/rules/harness-*.md`; keep project-specific knowledge here.

## What cc-harness is

A public Claude Code plugin that enforces guardrails from a per-project `.claude/harness.json`: a test guard, a commit guard, a post-edit quality gate, a destructive-git guard, a stop gate, and a session preflight, plus `init` to bootstrap a project. One repo is both the marketplace and the plugin. The design constraint everyone must know: **no config file means every hook is silent**, so a globally enabled plugin never touches an unrelated project. Zero dependencies, Node 18 or newer, no build step.

This repository runs cc-harness on itself with the `custom` preset (`.claude/harness.json`); the rules, git hook, and CI workflow here were produced by its own `init`.

## Commands

```sh
node --test test/*.test.mjs                       # unit and integration tests (flat test/ dir)
node --test test/glob.test.mjs                    # one file
claude plugin validate plugins/cc-harness --strict
node plugins/cc-harness/bin/harness.mjs version   # the CLI; also: hook <event> | init | doctor | sync-rules
node plugins/cc-harness/bin/harness.mjs doctor --target "$PWD"
```

## Layout

- `plugins/cc-harness/` is the plugin: `bin/harness.mjs` (entry), `lib/` (shared modules), `lib/guards/` (one module per guard, each `evaluate(ctx) → decision|null`), `presets/`, `templates/`, `skills/`.
- `test/` holds `*.test.mjs` files run with `node:test`; `test/helpers/project.mjs` builds temp projects.
- `docs/superpowers/specs/` and `docs/superpowers/plans/` hold the design specs and implementation plans this code was built from; `docs/presets.md` is the recipe for a new preset.
- `.superpowers/` is gitignored scratch for subagent-driven development ledgers.

## Sandbox notes

The Bash sandbox on this machine denies writes to `.git` and to `.claude/settings.json`; `git add`/`git commit` need the sandbox disabled, and settings edits go through the Edit tool. Nothing here needs the network.
