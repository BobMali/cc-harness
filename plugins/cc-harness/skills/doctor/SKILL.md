---
name: doctor
description: Check that cc-harness is correctly installed in the current project and explain every finding. Use when the user asks "is the harness working", "why did a guard not fire", "check the harness", or when the session preflight reports findings.
---

# cc-harness doctor

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/harness.mjs" doctor --target "$CLAUDE_PROJECT_DIR"
```

The command exits 1 only when a finding is an error (✖); warnings (⚠) alone leave it at 0. Report every line marked ⚠ or ✖ to the user with the fix:

| Finding | Fix |
|---|---|
| `.claude/harness.json not found` | run `/cc-harness:init` |
| `harness.json is invalid` | open the file, fix the listed key; every key is documented in `docs/presets.md` and the README |
| `marker file X not found` | the preset expects X at the project root; create it or set `project.markerFile` to `""` |
| `commit regex file not found` | run `/cc-harness:init` (refuses if other files exist; then create `githooks/conventional-regex.txt` by hand: line 1 regex, then `# types:` and `# scopes:` lines) |
| `git is not available on PATH` | install git; the git hook and doctor's `core.hooksPath` check cannot run without it |
| `githooks/commit-msg not found` | run `/cc-harness:init`, then `git config core.hooksPath githooks` |
| `core.hooksPath is not "githooks"` | `git config core.hooksPath githooks` |
| `rules ... missing` or `stamped vX but plugin is vY` | `node "${CLAUDE_PLUGIN_ROOT}/bin/harness.mjs" sync-rules --target "$CLAUDE_PROJECT_DIR"` |
| `node vN is below 18` | install Node 18 or newer; hooks cannot run otherwise |

A guard that "did not fire" almost always means one of: no `harness.json` (or it's invalid — guards go inactive except a PreToolUse ask), the marker file is absent, the guard is disabled in `guards.<name>.enabled`, or the path matched `ignoreGlobs`. For the test guard specifically, an empty `project.testGlobs` disables it outright. Check those in order.
