# cc-harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a public Claude Code plugin that enforces guardrails (test, commit, quality, git, stop, preflight) driven by a per-project `.claude/harness.json`, and bootstraps a project with `init`.

**Architecture:** One repo is both marketplace and plugin. A single Node entry point `bin/harness.mjs` dispatches to subcommands (`hook <event>`, `init`, `doctor`, `sync-rules`). Guards are pure modules `evaluate(ctx) → decision | null`; the CLI turns decisions into the hook JSON Claude Code expects. No config file means every hook is silent.

**Tech Stack:** Node.js ≥ 18, ES modules, `node:test`, `node:fs`, `node:child_process`. Zero dependencies, no build step.

**Spec:** `docs/superpowers/specs/2026-09-12-cc-harness-design.md`

## Global Constraints

- Node.js 18 is the floor: no `Array.prototype.toSorted`, no `structuredClone` assumptions beyond Node 17, no `import ... with { type: 'json' }`. Read JSON with `fs.readFileSync` + `JSON.parse`.
- Zero runtime dependencies. No `package.json` `dependencies`, no `npm install` needed to run the plugin or its tests.
- All config keys are **camelCase**.
- Every hook path returns exit 0 with no stdout when `.claude/harness.json` is absent.
- Commit messages: one conventional subject line, **no body, no trailers**. Types `feat fix docs test refactor build ci chore`; scopes `cli guards config render presets skills docs ci`.
- Test files live flat in `test/` as `test/<name>.test.mjs`; run with `node --test test/*.test.mjs` (works on Node 18 and 22).
- Hook output shapes (verified against docs): PreToolUse → `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask|deny","permissionDecisionReason":"..."}}`; PostToolUse and Stop → `{"decision":"block","reason":"..."}`; SessionStart → plain text on stdout.
- Sandbox note for every implementer: on this machine the Bash sandbox denies writes to `.git` (so `git add`/`git commit` fail with `index.lock: Operation not permitted`) and to this repo's `.claude/settings.json`, `.claude/skills`, `.claude/hooks`. Run every commit step with `dangerouslyDisableSandbox: true`; if the permission gate denies that, stop and report the tree as ready-to-commit instead of retrying. Use the Write/Edit tools, never Bash, for files under `.claude/`.
- The machine's `/bin/sh` is what `checks[].cmd` runs under (`spawnSync('/bin/sh', ['-c', cmd])`).

## File Structure

```
.claude-plugin/marketplace.json           T0  marketplace manifest
plugins/cc-harness/
  .claude-plugin/plugin.json              T0  name, version, description
  hooks/hooks.json                        T0  four events → bin/harness.mjs hook <event>
  bin/harness.mjs                         T0  #!/usr/bin/env node; calls lib/cli.mjs run()
  lib/cli.mjs                             T0 stub, T2–T7 fill  argv dispatch, hook orchestration
  lib/glob.mjs                            T1  globToRegExp, matchesGlob, matchesAny, mentionsAny
  lib/shell.mjs                           T1  splitSegments, tokenize, resolveTool, redirectTargets, isWrite, isSafe
  lib/config.mjs                          T1  DEFAULTS, BUILTIN_SAFE, loadConfig, mergeConfig, validateConfig, helpers
  lib/hook-io.mjs                         T1  readJson, decision constructors, toHookJson
  lib/meta.mjs                            T1  pluginRoot(), pluginVersion()
  lib/guards/test.mjs                     T2
  lib/guards/git.mjs                      T2
  lib/guards/commit.mjs                   T3
  lib/checks.mjs                          T4  selectChecks, runChecks, defaultExec, formatFailure
  lib/session.mjs                         T4  dirty marker read/write/clear/prune
  lib/guards/quality.mjs                  T4
  lib/guards/stop.mjs                     T4
  lib/doctor.mjs                          T5  findings + status block
  lib/guards/preflight.mjs                T5
  lib/render.mjs                          T6  render(), deepMergeSettings(), buildRegex()
  lib/init.mjs                            T6  init(), syncRules()
  presets/ts.json                         T6
  templates/CLAUDE.md.tmpl                T6
  templates/rules/harness-{testing,done,commits,models,harness}.md.tmpl  T6
  templates/githooks/commit-msg           T6  (static sh script)
  templates/ci.yml.tmpl                   T6
  skills/init/SKILL.md, skills/doctor/SKILL.md   T7
docs/presets.md, README.md               T7
test/*.test.mjs, test/helpers/project.mjs  T1+
.claude/harness.json, CLAUDE.md, .claude/rules/, githooks/, .github/workflows/harness.yml   T9 (dogfood, produced by init)
```

**Shared types (used by every guard):**

```js
// ctx passed to every guard's evaluate()
// {
//   event: 'PreToolUse'|'PostToolUse'|'Stop'|'SessionStart',
//   input: <parsed stdin JSON>,           // tool_name, tool_input, session_id, cwd, ...
//   config: <merged config>,              // see lib/config.mjs DEFAULTS for shape
//   projectDir: string,                   // absolute
//   dataDir: string,                      // CLAUDE_PLUGIN_DATA or os.tmpdir()/cc-harness
//   pluginRoot: string,
//   exec: (cmd, {cwd}) => ({ status, output }),
//   fs: node:fs (injectable in tests),
//   now: () => Date.now(),
// }
// decision: null | { kind: 'ask'|'deny'|'block'|'context'|'warn', reason: string }
```

---

### Task 0: Skeleton, manifests, CLI stub

**Files:**
- Create: `.claude-plugin/marketplace.json`
- Create: `plugins/cc-harness/.claude-plugin/plugin.json`
- Create: `plugins/cc-harness/hooks/hooks.json`
- Create: `plugins/cc-harness/bin/harness.mjs`
- Create: `plugins/cc-harness/lib/cli.mjs`
- Create: `README.md`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `run(argv, io) → Promise<number>` in `lib/cli.mjs`, where `io = { stdin, stdout, stderr, env }`. Later tasks replace the stub bodies of `runHook`, `runInit`, `runDoctor`, `runSyncRules` but keep these names.

- [ ] **Step 1: Write the manifests**

`.claude-plugin/marketplace.json`:
```json
{
  "name": "cc-harness",
  "description": "Guardrails and bootstrap for Claude Code projects: test guard, commit guard, quality gate, destructive-git guard, stop gate, session preflight.",
  "owner": { "name": "Malek Olabi" },
  "plugins": [
    {
      "name": "cc-harness",
      "description": "Config-driven guardrails for Claude Code",
      "source": "./plugins/cc-harness",
      "category": "productivity"
    }
  ]
}
```

`plugins/cc-harness/.claude-plugin/plugin.json`:
```json
{
  "name": "cc-harness",
  "version": "0.1.0",
  "description": "Config-driven guardrails for Claude Code: test guard, commit guard, quality gate, destructive-git guard, stop gate, session preflight, and a project bootstrap.",
  "author": { "name": "Malek Olabi" },
  "license": "MIT",
  "keywords": ["hooks", "guardrails", "tdd", "conventional-commits", "quality-gate"]
}
```

`plugins/cc-harness/hooks/hooks.json`:
```json
{
  "description": "cc-harness guards. Every event runs the same CLI; it reads .claude/harness.json and stays silent when that file is absent.",
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Write|Edit|MultiEdit",
        "hooks": [
          { "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/bin/harness.mjs\" hook PreToolUse", "timeout": 30 }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Write|Edit|MultiEdit",
        "hooks": [
          { "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/bin/harness.mjs\" hook PostToolUse", "timeout": 600 }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/bin/harness.mjs\" hook Stop", "timeout": 600 }
        ]
      }
    ],
    "SessionStart": [
      {
        "hooks": [
          { "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/bin/harness.mjs\" hook SessionStart", "timeout": 30 }
        ]
      }
    ]
  }
}
```

- [ ] **Step 2: Write the CLI entry and stub**

`plugins/cc-harness/bin/harness.mjs`:
```js
#!/usr/bin/env node
import { run } from '../lib/cli.mjs';

const code = await run(process.argv.slice(2), {
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
});
process.exitCode = code;
```

`plugins/cc-harness/lib/cli.mjs` (stub; later tasks fill the bodies):
```js
const USAGE = `usage: harness <command>

  hook <PreToolUse|PostToolUse|Stop|SessionStart>   run guards for a hook event (stdin: hook JSON)
  init [--preset ts|custom] [--types a,b] [--scopes a,b] [--marketplace owner/repo|path] [--force] [--dry-run] [--target dir]
  doctor [--target dir]
  sync-rules [--target dir]
  version
`;

export async function run(argv, io) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'hook':
      return runHook(rest[0], io);
    case 'init':
      return runInit(rest, io);
    case 'doctor':
      return runDoctor(rest, io);
    case 'sync-rules':
      return runSyncRules(rest, io);
    case 'version':
      io.stdout.write('0.1.0\n');
      return 0;
    case undefined:
    case '--help':
    case '-h':
      io.stdout.write(USAGE);
      return 0;
    default:
      io.stderr.write(`harness: unknown command "${cmd}"\n${USAGE}`);
      return 1;
  }
}

async function runHook(event, io) {
  // T2–T5 replace this. Until then: drain stdin, stay silent.
  for await (const _ of io.stdin) { /* drain */ }
  return 0;
}
async function runInit(args, io) { return 0; }        // T6
async function runDoctor(args, io) { return 0; }      // T5
async function runSyncRules(args, io) { return 0; }   // T6
```

- [ ] **Step 3: README stub and .gitignore**

`README.md`:
```markdown
# cc-harness

Config-driven guardrails and project bootstrap for Claude Code. Work in progress; see `docs/superpowers/specs/2026-09-12-cc-harness-design.md`.
```

Append to `.gitignore` if not present:
```
.claude/settings.local.json
```

- [ ] **Step 4: Verify**

Run:
```bash
chmod +x plugins/cc-harness/bin/harness.mjs
node plugins/cc-harness/bin/harness.mjs version
echo '{}' | node plugins/cc-harness/bin/harness.mjs hook PreToolUse; echo "exit=$?"
node plugins/cc-harness/bin/harness.mjs bogus; echo "exit=$?"
claude plugin validate plugins/cc-harness --strict
claude plugin validate . --strict
```
Expected: `0.1.0`; empty output then `exit=0`; usage on stderr then `exit=1`; both validations print `Validation passed`. If validating `.` refuses a marketplace root, run `claude plugin marketplace add "$PWD"` instead and confirm it succeeds, then `claude plugin marketplace remove cc-harness`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(cli): add plugin skeleton and command stub"
```

---

### Task 1: Foundations: glob, shell, config, hook-io, meta

**Files:**
- Create: `plugins/cc-harness/lib/glob.mjs`
- Create: `plugins/cc-harness/lib/shell.mjs`
- Create: `plugins/cc-harness/lib/config.mjs`
- Create: `plugins/cc-harness/lib/hook-io.mjs`
- Create: `plugins/cc-harness/lib/meta.mjs`
- Create: `test/helpers/project.mjs`
- Test: `test/glob.test.mjs`, `test/shell.test.mjs`, `test/config.test.mjs`, `test/hook-io.test.mjs`

**Interfaces:**
- Produces (glob): `globToRegExp(glob, {anchored=true}) → RegExp`; `matchesGlob(relPath, glob) → boolean`; `matchesAny(relPath, globs) → boolean`; `mentionsAny(text, globs) → boolean` (unanchored, for command lines).
- Produces (shell): `splitSegments(cmdline) → string[]`; `tokenize(segment) → string[]`; `resolveTool(tokens, runnerWrappers) → { word, args }`; `redirectTargets(segment) → string[]`; `isWrite(tokens, word, writeCommands) → boolean`; `isSafe({word, args}, config) → boolean`.
- Produces (config): `DEFAULTS`, `BUILTIN_SAFE`, `SUPPORTED_VERSION = 1`, `mergeConfig(base, over)`, `validateConfig(config) → string[]`, `loadConfig(projectDir, {presetsDir}) → {status:'absent'} | {status:'invalid', errors, config?} | {status:'ok', config}`, `isGuardEnabled(config, name)`, `checksByName(config, names)`, `relTo(projectDir, p)`.
- Produces (hook-io): `readJson(stream) → Promise<object|null>`; `ask(reason)`, `deny(reason)`, `block(reason)`, `context(text)`, `warn(reason)` → decision objects; `toHookJson(event, decision) → object|null`.
- Produces (meta): `pluginRoot() → string` (directory containing `.claude-plugin/plugin.json`), `pluginVersion() → string`.
- Produces (test helper): `makeProject({ config, files, marker }) → { dir, cleanup }`.

- [ ] **Step 1: Write failing glob tests**

`test/glob.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { globToRegExp, matchesGlob, matchesAny, mentionsAny } from '../plugins/cc-harness/lib/glob.mjs';

test('* does not cross directory boundaries', () => {
  assert.equal(matchesGlob('a.test.ts', '*.test.ts'), true);
  assert.equal(matchesGlob('src/a.test.ts', '*.test.ts'), true); // basename fallback for slash-less globs
  assert.equal(matchesGlob('src/a.test.ts', 'src/*.ts'), true);
  assert.equal(matchesGlob('src/deep/a.test.ts', 'src/*.ts'), false);
});

test('** matches zero or more directories', () => {
  assert.equal(matchesGlob('a.test.ts', '**/*.test.*'), true);
  assert.equal(matchesGlob('src/deep/a.test.ts', '**/*.test.*'), true);
  assert.equal(matchesGlob('src/__tests__/a.ts', '**/__tests__/**'), true);
  assert.equal(matchesGlob('node_modules/x/index.js', '**/node_modules/**'), true);
  assert.equal(matchesGlob('src/a.ts', '**/__tests__/**'), false);
});

test('regex metacharacters in globs are literal', () => {
  assert.equal(matchesGlob('a.ts', '*.ts'), true);
  assert.equal(matchesGlob('ats', '*.ts'), false);
  assert.equal(globToRegExp('a+b').test('a+b'), true);
  assert.equal(globToRegExp('a+b').test('aab'), false);
});

test('matchesAny and mentionsAny', () => {
  assert.equal(matchesAny('x/y.spec.tsx', ['**/*.test.*', '**/*.spec.*']), true);
  assert.equal(matchesAny('x/y.tsx', ['**/*.test.*']), false);
  assert.equal(mentionsAny(`node -e "require('fs').writeFileSync('x.test.ts','')"`, ['**/*.test.*']), true);
  assert.equal(mentionsAny('vitest run', ['**/*.test.*']), false);
  assert.equal(mentionsAny('cat src/__tests__/a.ts', ['**/__tests__/**']), true);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/glob.test.mjs`
Expected: FAIL, `Cannot find module '.../lib/glob.mjs'`.

- [ ] **Step 3: Implement glob.mjs**

```js
const RE_SPECIAL = /[.+^${}()|[\]\\]/g;

export function globToRegExp(glob, { anchored = true } = {}) {
  let re = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 3; continue; }
        re += '.*'; i += 2; continue;
      }
      re += '[^/]*'; i += 1; continue;
    }
    if (c === '?') { re += '[^/]'; i += 1; continue; }
    re += c.replace(RE_SPECIAL, '\\$&');
    i += 1;
  }
  return new RegExp(anchored ? `^${re}$` : re);
}

function normalize(p) {
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '');
}

export function matchesGlob(relPath, glob) {
  const p = normalize(relPath);
  if (globToRegExp(glob).test(p)) return true;
  if (!glob.includes('/')) return globToRegExp(glob).test(p.slice(p.lastIndexOf('/') + 1));
  return false;
}

export function matchesAny(relPath, globs = []) {
  return globs.some((g) => matchesGlob(relPath, g));
}

export function mentionsAny(text, globs = []) {
  return globs.some((g) => globToRegExp(g, { anchored: false }).test(String(text)));
}
```

- [ ] **Step 4: Run glob tests**

Run: `node --test test/glob.test.mjs`
Expected: all PASS.

- [ ] **Step 5: Write failing shell tests**

`test/shell.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitSegments, tokenize, resolveTool, redirectTargets, isWrite, isSafe } from '../plugins/cc-harness/lib/shell.mjs';
import { DEFAULTS, mergeConfig } from '../plugins/cc-harness/lib/config.mjs';

const W = ['npx', 'pnpm', 'yarn', 'bunx', 'bun', 'npm'];

test('splitSegments splits on ; && || | and newline, not inside quotes or 2>&1', () => {
  assert.deepEqual(splitSegments('a; b && c || d | e\nf'), ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.deepEqual(splitSegments(`echo "a;b" && echo 'c|d'`), ['echo "a;b"', `echo 'c|d'`]);
  assert.deepEqual(splitSegments('cmd 2>&1 | tee out'), ['cmd 2>&1', 'tee out']);
  assert.deepEqual(splitSegments('  '), []);
});

test('tokenize is quote-aware', () => {
  assert.deepEqual(tokenize(`sed -i '' "s/a b/c/" x.test.ts`), ['sed', '-i', '', 's/a b/c/', 'x.test.ts']);
  assert.deepEqual(tokenize(`node -e "require('fs')"`), ['node', '-e', "require('fs')"]);
});

test('resolveTool strips env assignments, paths, and runner wrappers', () => {
  assert.deepEqual(resolveTool(tokenize('FOO=1 env vendor/bin/phpunit tests/A.php'), W), { word: 'phpunit', args: ['tests/A.php'] });
  assert.deepEqual(resolveTool(tokenize('npx vitest run x.test.ts'), W), { word: 'vitest', args: ['run', 'x.test.ts'] });
  assert.deepEqual(resolveTool(tokenize('npm run lint:fix src'), W), { word: 'lint:fix', args: ['src'] });
  assert.deepEqual(resolveTool(tokenize('npm test -- x.test.ts'), W), { word: 'test', args: ['--', 'x.test.ts'] });
  assert.deepEqual(resolveTool(tokenize('pnpm exec eslint --fix .'), W), { word: 'eslint', args: ['--fix', '.'] });
  assert.deepEqual(resolveTool(tokenize('node_modules/.bin/tsc --noEmit'), W), { word: 'tsc', args: ['--noEmit'] });
  assert.deepEqual(resolveTool([], W), { word: '', args: [] });
});

test('redirectTargets finds > and >> targets, ignores 2>&1', () => {
  assert.deepEqual(redirectTargets('echo x > a.test.ts'), ['a.test.ts']);
  assert.deepEqual(redirectTargets('echo x >>b.spec.js 2>&1'), ['b.spec.js']);
  assert.deepEqual(redirectTargets('cat a.test.ts'), []);
});

test('isWrite consults whenFlags / unlessFlags / bare entries', () => {
  const wc = [
    { cmd: 'prettier', whenFlags: ['--write', '-w'] },
    { cmd: 'php-cs-fixer', unlessFlags: ['--dry-run'] },
    { cmd: 'phpcbf' },
  ];
  assert.equal(isWrite(['prettier', '--check', '.'], 'prettier', wc), false);
  assert.equal(isWrite(['prettier', '-w', '.'], 'prettier', wc), true);
  assert.equal(isWrite(['php-cs-fixer', 'fix', '--dry-run'], 'php-cs-fixer', wc), false);
  assert.equal(isWrite(['php-cs-fixer', 'fix'], 'php-cs-fixer', wc), true);
  assert.equal(isWrite(['phpcbf', 'x'], 'phpcbf', wc), true);
  assert.equal(isWrite(['cat', 'x'], 'cat', wc), false);
});

test('isSafe: builtin list, config list, git read-only subcommands', () => {
  const cfg = mergeConfig(DEFAULTS, { commands: { safe: ['vitest'] } });
  assert.equal(isSafe({ word: 'cat', args: [] }, cfg), true);
  assert.equal(isSafe({ word: 'vitest', args: ['run'] }, cfg), true);
  assert.equal(isSafe({ word: 'sed', args: [] }, cfg), false);
  assert.equal(isSafe({ word: 'git', args: ['diff', 'x.test.ts'] }, cfg), true);
  assert.equal(isSafe({ word: 'git', args: ['checkout', 'x.test.ts'] }, cfg), false);
  assert.equal(isSafe({ word: 'test', args: [] }, cfg), true);
});
```

- [ ] **Step 6: Run to verify failure**

Run: `node --test test/shell.test.mjs`
Expected: FAIL, cannot find module `shell.mjs`.

- [ ] **Step 7: Implement shell.mjs**

```js
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const PREFIX_WORDS = new Set(['env', 'sudo', 'time', 'nice', 'command']);
const SKIP_AFTER_WRAPPER = new Set(['run', 'run-script', 'exec', 'dlx', 'x', '--', '-y', '--yes', '-s', '--silent', '-q', '--quiet']);
const GIT_SAFE_SUB = new Set(['status', 'diff', 'log', 'show', 'blame', 'grep', 'ls-files', 'rev-parse', 'branch', 'remote', 'add', 'commit', 'stash', 'tag', 'describe']);

export function splitSegments(cmdline) {
  const segs = [];
  let cur = '';
  let q = null;
  const s = String(cmdline);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      cur += c;
      if (c === q) q = null;
      else if (c === '\\' && q === '"') cur += s[++i] ?? '';
      continue;
    }
    if (c === "'" || c === '"') { q = c; cur += c; continue; }
    if (c === '\\') { cur += c + (s[++i] ?? ''); continue; }
    if (c === '\n' || c === ';') { segs.push(cur); cur = ''; continue; }
    if (c === '&' && cur.endsWith('>')) { cur += c; continue; }   // 2>&1
    if (c === '&' || c === '|') {
      if (s[i + 1] === c) i++;
      segs.push(cur); cur = '';
      continue;
    }
    cur += c;
  }
  segs.push(cur);
  return segs.map((x) => x.trim()).filter(Boolean);
}

export function tokenize(segment) {
  const toks = [];
  let cur = '';
  let started = false;
  let q = null;
  const s = String(segment);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) q = null;
      else if (c === '\\' && q === '"') cur += s[++i] ?? '';
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') { q = c; started = true; continue; }
    if (c === '\\') { cur += s[++i] ?? ''; started = true; continue; }
    if (/\s/.test(c)) { if (started) toks.push(cur); cur = ''; started = false; continue; }
    cur += c; started = true;
  }
  if (started) toks.push(cur);
  return toks;
}

const base = (t) => t.slice(t.lastIndexOf('/') + 1);

export function resolveTool(tokens, runnerWrappers = []) {
  let i = 0;
  while (i < tokens.length && (ENV_ASSIGN.test(tokens[i]) || PREFIX_WORDS.has(tokens[i]))) i++;
  if (i >= tokens.length) return { word: '', args: [] };
  let word = base(tokens[i]);
  i++;
  if (runnerWrappers.includes(word)) {
    while (i < tokens.length && SKIP_AFTER_WRAPPER.has(tokens[i])) i++;
    if (i < tokens.length) { word = base(tokens[i]); i++; }
  }
  return { word, args: tokens.slice(i) };
}

export function redirectTargets(segment) {
  const out = [];
  const re = /(?:^|[\s\d])>{1,2}\s*([^\s&|;<>]+)/g;
  let m;
  while ((m = re.exec(String(segment))) !== null) out.push(m[1]);
  return out;
}

export function isWrite(tokens, word, writeCommands = []) {
  for (const w of writeCommands) {
    if (w.cmd !== word) continue;
    if (Array.isArray(w.whenFlags)) return w.whenFlags.some((f) => tokens.includes(f));
    if (Array.isArray(w.unlessFlags)) return !w.unlessFlags.some((f) => tokens.includes(f));
    return true;
  }
  return false;
}

export function isSafe({ word, args }, config) {
  if (!word) return false;
  if (word === 'git') return GIT_SAFE_SUB.has(args.find((a) => !a.startsWith('-')) ?? '');
  const safe = new Set([...(config.builtinSafe ?? []), ...(config.commands?.safe ?? [])]);
  return safe.has(word);
}
```

Note: `config.builtinSafe` is populated by `mergeConfig` in Step 11 (DEFAULTS carries it), so `isSafe` never needs to import config.

- [ ] **Step 8: Run shell tests**

Run: `node --test test/shell.test.mjs`
Expected: FAIL at import time with cannot find module `config.mjs` (the shell test imports `DEFAULTS` and `mergeConfig`). That is the right failure for now; the file passes after Step 11. Proceed.

- [ ] **Step 9: Write the project fixture helper**

`test/helpers/project.mjs`:
```js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// makeProject({ config, files, marker }) → { dir, cleanup, write, read, exists }
// config: object written to .claude/harness.json (omit to create no config)
// files:  { 'relative/path': 'content' }
export function makeProject({ config, files = {}, marker } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-harness-'));
  const write = (rel, content, mode) => {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    if (mode) fs.chmodSync(abs, mode);
    return abs;
  };
  if (config !== undefined) write('.claude/harness.json', JSON.stringify(config, null, 2));
  if (marker) write(marker, '{}');
  for (const [rel, content] of Object.entries(files)) write(rel, content);
  return {
    dir,
    write,
    read: (rel) => fs.readFileSync(path.join(dir, rel), 'utf8'),
    exists: (rel) => fs.existsSync(path.join(dir, rel)),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

export function makeDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-harness-data-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
```

- [ ] **Step 10: Write failing config tests**

`test/config.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, mergeConfig, validateConfig, loadConfig, isGuardEnabled, checksByName, relTo } from '../plugins/cc-harness/lib/config.mjs';
import { makeProject } from './helpers/project.mjs';

const PRESETS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'presets');

test('mergeConfig: objects merge deeply, arrays are replaced, scalars overridden', () => {
  const out = mergeConfig(DEFAULTS, { project: { testGlobs: ['*.t'] }, guards: { stop: { enabled: false } } });
  assert.deepEqual(out.project.testGlobs, ['*.t']);
  assert.deepEqual(out.project.ignoreGlobs, DEFAULTS.project.ignoreGlobs);
  assert.equal(out.guards.stop.enabled, false);
  assert.equal(out.guards.stop.maxBlocks, 3);
  assert.equal(out.guards.commit.enabled, true);
  assert.notEqual(out, DEFAULTS);
  assert.deepEqual(DEFAULTS.guards.stop, { enabled: true, checks: [], maxBlocks: 3 }); // no mutation
});

test('loadConfig: absent file → status absent', () => {
  const p = makeProject({});
  try { assert.deepEqual(loadConfig(p.dir, { presetsDir: PRESETS }), { status: 'absent' }); } finally { p.cleanup(); }
});

test('loadConfig: invalid JSON → status invalid with message', () => {
  const p = makeProject({ files: { '.claude/harness.json': '{ nope' } });
  try {
    const r = loadConfig(p.dir, { presetsDir: PRESETS });
    assert.equal(r.status, 'invalid');
    assert.match(r.errors[0], /harness\.json/);
  } finally { p.cleanup(); }
});

test('loadConfig: preset merged under user keys, unknown preset rejected', () => {
  const p = makeProject({ config: { version: 1, preset: 'fixture', guards: { quality: { scope: 'all' } } } });
  try {
    const r = loadConfig(p.dir, { presetsDir: PRESETS });
    assert.equal(r.status, 'ok');
    assert.equal(r.config.project.markerFile, 'marker.txt');   // from fixture preset
    assert.equal(r.config.guards.quality.scope, 'all');          // user wins
    assert.deepEqual(r.config.commands.runnerWrappers, DEFAULTS.commands.runnerWrappers);
  } finally { p.cleanup(); }
  const q = makeProject({ config: { version: 1, preset: 'nope' } });
  try { assert.equal(loadConfig(q.dir, { presetsDir: PRESETS }).status, 'invalid'); } finally { q.cleanup(); }
});

test('validateConfig catches shape errors', () => {
  const bad = mergeConfig(DEFAULTS, {
    version: 2,
    checks: [{ name: 'a', cmd: 'true' }, { name: 'a', cmd: 'true' }, { name: 'b' }],
    guards: { stop: { checks: ['zzz'], maxBlocks: 9 }, quality: { scope: 'medium' } },
  });
  const errs = validateConfig(bad);
  for (const re of [/version/, /duplicate check name "a"/, /checks\[2\]\.cmd/, /stop\.checks.*"zzz"/, /maxBlocks/, /quality\.scope/]) {
    assert.ok(errs.some((e) => re.test(e)), `expected an error matching ${re}: ${JSON.stringify(errs)}`);
  }
  assert.deepEqual(validateConfig(DEFAULTS), []);
});

test('helpers', () => {
  const cfg = mergeConfig(DEFAULTS, { checks: [{ name: 'a', cmd: 'true' }, { name: 'b', cmd: 'true' }], guards: { git: { enabled: false } } });
  assert.equal(isGuardEnabled(cfg, 'git'), false);
  assert.equal(isGuardEnabled(cfg, 'test'), true);
  assert.deepEqual(checksByName(cfg, ['b']).map((c) => c.name), ['b']);
  assert.equal(relTo('/p', '/p/src/a.ts'), 'src/a.ts');
  assert.equal(relTo('/p', 'src/a.ts'), 'src/a.ts');
});
```

Create the fixture preset `test/fixtures/presets/fixture.json`:
```json
{ "project": { "markerFile": "marker.txt", "sourceGlobs": ["**/*.js"], "testGlobs": ["**/*.test.js"] }, "checks": [{ "name": "t", "cmd": "true", "fast": true }] }
```

- [ ] **Step 11: Implement config.mjs**

```js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SUPPORTED_VERSION = 1;
export const GUARD_NAMES = ['test', 'commit', 'quality', 'git', 'stop', 'preflight'];

export const BUILTIN_SAFE = [
  'cat', 'head', 'tail', 'less', 'more', 'grep', 'rg', 'egrep', 'fgrep', 'wc', 'ls', 'stat', 'file',
  'realpath', 'basename', 'dirname', 'sort', 'uniq', 'cut', 'tr', 'nl', 'column', 'bat', 'diff', 'cmp',
  'shasum', 'md5', 'md5sum', 'echo', 'printf', 'true', 'test', 'find', 'which', 'pwd',
];

export const DEFAULTS = Object.freeze({
  version: 1,
  preset: 'custom',
  project: {
    markerFile: '',
    sourceGlobs: [],
    testGlobs: [],
    ignoreGlobs: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/.git/**'],
  },
  commands: {
    safe: [],
    write: [],
    runnerWrappers: ['npx', 'pnpm', 'yarn', 'bunx', 'bun', 'npm'],
  },
  checks: [],
  guards: {
    test: { enabled: true },
    commit: { enabled: true, regexFile: 'githooks/conventional-regex.txt', rejectAttributionTrailers: true },
    quality: { enabled: true, scope: 'fast' },
    git: { enabled: true },
    stop: { enabled: true, checks: [], maxBlocks: 3 },
    preflight: { enabled: true },
  },
  builtinSafe: BUILTIN_SAFE,
});

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function mergeConfig(base, over) {
  if (!isObj(base) || !isObj(over)) return over === undefined ? clone(base) : clone(over);
  const out = {};
  for (const k of new Set([...Object.keys(base), ...Object.keys(over)])) {
    if (!(k in over)) out[k] = clone(base[k]);
    else if (isObj(base[k]) && isObj(over[k])) out[k] = mergeConfig(base[k], over[k]);
    else out[k] = clone(over[k]);
  }
  return out;
}

function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

export function defaultPresetsDir() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'presets');
}

export function loadPreset(name, presetsDir = defaultPresetsDir()) {
  if (!/^[a-z0-9-]+$/.test(name)) return null;
  const file = path.join(presetsDir, `${name}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function configPath(projectDir) {
  return path.join(projectDir, '.claude', 'harness.json');
}

export function loadConfig(projectDir, { presetsDir = defaultPresetsDir() } = {}) {
  const file = configPath(projectDir);
  if (!fs.existsSync(file)) return { status: 'absent' };
  let user;
  try {
    user = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { status: 'invalid', errors: [`.claude/harness.json is not valid JSON: ${e.message}`] };
  }
  if (!isObj(user)) return { status: 'invalid', errors: ['.claude/harness.json must contain a JSON object'] };
  const presetName = user.preset ?? 'custom';
  let preset = {};
  if (presetName !== 'custom') {
    preset = loadPreset(presetName, presetsDir);
    if (preset === null) return { status: 'invalid', errors: [`unknown preset "${presetName}" (no ${presetName}.json in presets/)`] };
  }
  const config = mergeConfig(mergeConfig(DEFAULTS, preset), user);
  const errors = validateConfig(config);
  return errors.length ? { status: 'invalid', errors, config } : { status: 'ok', config };
}

export function validateConfig(c) {
  const errors = [];
  const strArr = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
  if (c.version !== SUPPORTED_VERSION) errors.push(`version must be ${SUPPORTED_VERSION}, got ${JSON.stringify(c.version)}`);
  for (const k of ['sourceGlobs', 'testGlobs', 'ignoreGlobs']) {
    if (!strArr(c.project?.[k])) errors.push(`project.${k} must be an array of strings`);
  }
  if (typeof c.project?.markerFile !== 'string') errors.push('project.markerFile must be a string');
  if (!strArr(c.commands?.safe)) errors.push('commands.safe must be an array of strings');
  if (!strArr(c.commands?.runnerWrappers)) errors.push('commands.runnerWrappers must be an array of strings');
  if (!Array.isArray(c.commands?.write)) errors.push('commands.write must be an array');
  else c.commands.write.forEach((w, i) => { if (!isObj(w) || typeof w.cmd !== 'string') errors.push(`commands.write[${i}].cmd must be a string`); });
  const names = new Set();
  if (!Array.isArray(c.checks)) errors.push('checks must be an array');
  else c.checks.forEach((ch, i) => {
    if (!isObj(ch)) { errors.push(`checks[${i}] must be an object`); return; }
    if (typeof ch.name !== 'string' || !ch.name) errors.push(`checks[${i}].name must be a non-empty string`);
    else if (names.has(ch.name)) errors.push(`duplicate check name "${ch.name}"`);
    else names.add(ch.name);
    if (typeof ch.cmd !== 'string' || !ch.cmd) errors.push(`checks[${i}].cmd must be a non-empty string`);
  });
  for (const g of GUARD_NAMES) {
    if (typeof c.guards?.[g]?.enabled !== 'boolean') errors.push(`guards.${g}.enabled must be a boolean`);
  }
  if (!['fast', 'all'].includes(c.guards?.quality?.scope)) errors.push(`guards.quality.scope must be "fast" or "all"`);
  if (typeof c.guards?.commit?.regexFile !== 'string') errors.push('guards.commit.regexFile must be a string');
  const mb = c.guards?.stop?.maxBlocks;
  if (!Number.isInteger(mb) || mb < 0 || mb > 7) errors.push('guards.stop.maxBlocks must be an integer between 0 and 7');
  if (!strArr(c.guards?.stop?.checks)) errors.push('guards.stop.checks must be an array of strings');
  else for (const n of c.guards.stop.checks) if (!names.has(n)) errors.push(`guards.stop.checks names unknown check "${n}"`);
  return errors;
}

export function isGuardEnabled(config, name) {
  return config.guards?.[name]?.enabled === true;
}

export function checksByName(config, names) {
  const byName = new Map(config.checks.map((c) => [c.name, c]));
  return names.map((n) => byName.get(n)).filter(Boolean);
}

export function relTo(projectDir, p) {
  const abs = path.isAbsolute(p) ? p : path.resolve(projectDir, p);
  return path.relative(projectDir, abs).replace(/\\/g, '/');
}
```

- [ ] **Step 12: Run config and shell tests**

Run: `node --test test/config.test.mjs test/shell.test.mjs`
Expected: all PASS.

- [ ] **Step 13: Write failing hook-io and meta tests**

`test/hook-io.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readJson, ask, deny, block, context, warn, toHookJson, pickDecision } from '../plugins/cc-harness/lib/hook-io.mjs';
import { pluginRoot, pluginVersion } from '../plugins/cc-harness/lib/meta.mjs';

test('readJson parses stdin, tolerates empty and garbage', async () => {
  assert.deepEqual(await readJson(Readable.from(['{"a":', '1}'])), { a: 1 });
  assert.equal(await readJson(Readable.from([''])), null);
  assert.equal(await readJson(Readable.from(['nope'])), null);
});

test('decision constructors and hook JSON shapes', () => {
  assert.deepEqual(ask('r'), { kind: 'ask', reason: 'r' });
  assert.deepEqual(toHookJson('PreToolUse', ask('why')), {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'why' },
  });
  assert.deepEqual(toHookJson('PreToolUse', deny('no')).hookSpecificOutput.permissionDecision, 'deny');
  assert.deepEqual(toHookJson('PostToolUse', block('fix')), { decision: 'block', reason: 'fix' });
  assert.deepEqual(toHookJson('Stop', block('fix')), { decision: 'block', reason: 'fix' });
  assert.deepEqual(toHookJson('Stop', warn('released')), { systemMessage: 'released' });
  assert.equal(toHookJson('SessionStart', context('hello')), null); // context is printed as plain text, not JSON
  assert.equal(toHookJson('PreToolUse', null), null);
});

test('pickDecision: deny beats ask beats null', () => {
  assert.deepEqual(pickDecision([null, ask('a'), deny('d'), ask('b')]), deny('d'));
  assert.deepEqual(pickDecision([null, ask('a')]), ask('a'));
  assert.equal(pickDecision([null, null]), null);
});

test('meta reads plugin.json', () => {
  assert.match(pluginRoot(), /plugins\/cc-harness$/);
  assert.match(pluginVersion(), /^\d+\.\d+\.\d+$/);
});
```

- [ ] **Step 14: Implement hook-io.mjs and meta.mjs**

`lib/hook-io.mjs`:
```js
export async function readJson(stream) {
  let s = '';
  for await (const chunk of stream) s += chunk;
  s = s.trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

export const ask = (reason) => ({ kind: 'ask', reason });
export const deny = (reason) => ({ kind: 'deny', reason });
export const block = (reason) => ({ kind: 'block', reason });
export const context = (text) => ({ kind: 'context', reason: text });
export const warn = (reason) => ({ kind: 'warn', reason });

const RANK = { deny: 3, ask: 2, block: 2, warn: 1, context: 1 };

export function pickDecision(decisions) {
  let best = null;
  for (const d of decisions) {
    if (!d) continue;
    if (!best || RANK[d.kind] > RANK[best.kind]) best = d;
  }
  return best;
}

export function toHookJson(event, decision) {
  if (!decision) return null;
  switch (decision.kind) {
    case 'ask':
    case 'deny':
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision.kind, permissionDecisionReason: decision.reason } };
    case 'block':
      return { decision: 'block', reason: decision.reason };
    case 'warn':
      return { systemMessage: decision.reason };
    default:
      return null;
  }
}
```

`lib/meta.mjs`:
```js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function pluginRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

export function pluginVersion() {
  const manifest = path.join(pluginRoot(), '.claude-plugin', 'plugin.json');
  return JSON.parse(fs.readFileSync(manifest, 'utf8')).version ?? '0.0.0';
}
```

Also change `lib/cli.mjs` `version` case to `io.stdout.write(pluginVersion() + '\n')` with the import.

- [ ] **Step 15: Run the whole suite**

Run: `node --test test/*.test.mjs`
Expected: all PASS.

- [ ] **Step 16: Commit**

```bash
git add -A
git commit -m "feat(config): add glob, shell, config, and hook-io foundations"
```

---

### Task 2: Test guard, destructive-git guard, PreToolUse dispatch

**Files:**
- Create: `plugins/cc-harness/lib/guards/test.mjs`
- Create: `plugins/cc-harness/lib/guards/git.mjs`
- Create: `plugins/cc-harness/lib/guards/index.mjs`
- Modify: `plugins/cc-harness/lib/cli.mjs` (replace `runHook`)
- Test: `test/guard-test.test.mjs`, `test/guard-git.test.mjs`, `test/cli-hook.test.mjs`

**Interfaces:**
- Consumes: T1 glob/shell/config/hook-io exports as named above.
- Produces: each guard module exports `name` (string), `event` (string), `evaluate(ctx) → decision|null`. `lib/guards/index.mjs` exports `GUARDS` (array of guard modules; T3–T5 append to it) and `guardsFor(event)`. `lib/cli.mjs` exports `runHook(event, io, overrides)` where `overrides` may carry `{ exec, dataDir, presetsDir }` for tests.

- [ ] **Step 1: Write failing test-guard tests**

`test/guard-test.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { evaluate } from '../plugins/cc-harness/lib/guards/test.mjs';
import { DEFAULTS, mergeConfig } from '../plugins/cc-harness/lib/config.mjs';
import { makeProject } from './helpers/project.mjs';

const cfg = mergeConfig(DEFAULTS, {
  project: { testGlobs: ['**/*.test.*', '**/*.spec.*', '**/__tests__/**'], sourceGlobs: ['**/*.ts'] },
  commands: {
    safe: ['node', 'vitest', 'jest', 'eslint', 'prettier', 'tsc'],
    write: [
      { cmd: 'prettier', whenFlags: ['--write', '-w'] },
      { cmd: 'eslint', whenFlags: ['--fix'] },
      { cmd: 'node', whenFlags: ['-e', '--eval', '-p', '--print'] },
    ],
  },
});

function ctx(p, tool, tool_input) {
  return { event: 'PreToolUse', input: { tool_name: tool, tool_input }, config: cfg, projectDir: p.dir };
}

test('edit tools: existing test file asks, new test file and source file pass', () => {
  const p = makeProject({ files: { 'src/a.test.ts': 'x', 'src/a.ts': 'y' } });
  try {
    const existing = evaluate(ctx(p, 'Edit', { file_path: path.join(p.dir, 'src/a.test.ts'), old_string: 'x', new_string: 'z' }));
    assert.equal(existing?.kind, 'ask');
    assert.match(existing.reason, /src\/a\.test\.ts/);
    assert.equal(evaluate(ctx(p, 'Write', { file_path: path.join(p.dir, 'src/b.test.ts'), content: '' })), null);
    assert.equal(evaluate(ctx(p, 'Edit', { file_path: path.join(p.dir, 'src/a.ts') })), null);
    assert.equal(evaluate(ctx(p, 'MultiEdit', { file_path: path.join(p.dir, 'src/a.test.ts'), edits: [] }))?.kind, 'ask');
    assert.equal(evaluate(ctx(p, 'Edit', { file_path: path.join(p.dir, 'node_modules/x/a.test.ts') })), null); // ignored path
  } finally { p.cleanup(); }
});

test('bash: the ldsum vectors, translated', () => {
  const p = makeProject({ files: { 'x.test.ts': '' } });
  const bash = (command) => evaluate(ctx(p, 'Bash', { command }));
  try {
    assert.equal(bash('vitest run x.test.ts'), null);
    assert.equal(bash('npx vitest run x.test.ts'), null);
    assert.equal(bash('npm test -- x.test.ts'), null);
    assert.equal(bash('node_modules/.bin/vitest run src/x.test.ts'), null);
    assert.equal(bash('cat x.test.ts | head'), null);
    assert.equal(bash('git diff x.test.ts'), null);
    assert.equal(bash('prettier --check x.test.ts'), null);
    assert.equal(bash('vitest run'), null);
    assert.equal(bash(`sed -i '' 's/a/b/' x.test.ts`)?.kind, 'ask');
    assert.equal(bash('rm x.test.ts')?.kind, 'ask');
    assert.equal(bash('mv x.test.ts y.test.ts')?.kind, 'ask');
    assert.equal(bash('prettier --write x.test.ts')?.kind, 'ask');
    assert.equal(bash('eslint --fix src/x.test.ts')?.kind, 'ask');
    assert.equal(bash(`node -e "require('fs').writeFileSync('x.test.ts','')"`)?.kind, 'ask');
    assert.equal(bash('echo x > x.test.ts')?.kind, 'ask');
    assert.equal(bash('cat a.ts >> src/__tests__/b.ts')?.kind, 'ask');
    assert.equal(bash('npm run lint:fix x.test.ts')?.kind, 'ask'); // unknown script word, conservative
    assert.equal(bash('ls && rm x.test.ts')?.kind, 'ask');           // second segment
    assert.equal(bash('git checkout x.test.ts')?.kind, 'ask');
  } finally { p.cleanup(); }
});

test('no test globs configured → never asks', () => {
  const p = makeProject({ files: { 'x.test.ts': '' } });
  try {
    const c = { ...ctx(p, 'Bash', { command: 'rm x.test.ts' }), config: mergeConfig(DEFAULTS, {}) };
    assert.equal(evaluate(c), null);
  } finally { p.cleanup(); }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/guard-test.test.mjs`
Expected: FAIL, cannot find module `guards/test.mjs`.

- [ ] **Step 3: Implement guards/test.mjs**

```js
import fs from 'node:fs';
import path from 'node:path';
import { matchesAny, mentionsAny } from '../glob.mjs';
import { splitSegments, tokenize, resolveTool, redirectTargets, isWrite, isSafe } from '../shell.mjs';
import { relTo } from '../config.mjs';
import { ask } from '../hook-io.mjs';

export const name = 'test';
export const event = 'PreToolUse';

const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);
const PREFIX = 'cc-harness test guard';

export function evaluate({ input, config, projectDir }) {
  const { testGlobs, ignoreGlobs } = config.project;
  if (!testGlobs.length) return null;
  const tool = input.tool_name;
  const ti = input.tool_input ?? {};

  if (EDIT_TOOLS.has(tool)) {
    if (typeof ti.file_path !== 'string' || !ti.file_path) return null;
    const rel = relTo(projectDir, ti.file_path);
    if (matchesAny(rel, ignoreGlobs) || !matchesAny(rel, testGlobs)) return null;
    if (!fs.existsSync(path.resolve(projectDir, ti.file_path))) return null;
    return ask(`${PREFIX}: ${rel} is an existing test file. Changing an existing test needs explicit permission; explain what the test gets wrong and ask before editing it.`);
  }

  if (tool === 'Bash') {
    const command = typeof ti.command === 'string' ? ti.command : '';
    for (const seg of splitSegments(command)) {
      const tokens = tokenize(seg);
      const tw = resolveTool(tokens, config.commands.runnerWrappers);
      const redirected = redirectTargets(seg).filter((t) => mentionsAny(t, testGlobs));
      if (redirected.length) return ask(`${PREFIX}: this command redirects output into the test file ${redirected[0]}.`);
      if (!mentionsAny(seg, testGlobs)) continue;
      if (isWrite(tokens, tw.word, config.commands.write)) {
        return ask(`${PREFIX}: "${tw.word}" rewrites files in place and the command names a test file. Confirm the test change first.`);
      }
      if (isSafe(tw, config)) continue;
      return ask(`${PREFIX}: "${tw.word || seg}" is not a known read-only or test-running command and the command names a test file. Confirm the test change first.`);
    }
  }
  return null;
}
```

- [ ] **Step 4: Run test-guard tests**

Run: `node --test test/guard-test.test.mjs`
Expected: PASS.

- [ ] **Step 5: Write failing git-guard tests**

`test/guard-git.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../plugins/cc-harness/lib/guards/git.mjs';
import { DEFAULTS } from '../plugins/cc-harness/lib/config.mjs';

const bash = (command) => evaluate({ event: 'PreToolUse', input: { tool_name: 'Bash', tool_input: { command } }, config: DEFAULTS, projectDir: '/p' });

test('destructive git commands ask', () => {
  for (const c of [
    'git reset --hard', 'git reset --hard HEAD~1', 'git checkout .', 'git checkout -- src/a.ts', 'git restore .',
    'git clean -f', 'git clean -fdx', 'git push --force', 'git push -f origin main', 'git branch -D feature',
    'git stash drop', 'git stash clear', 'git -C /x push -f', 'cd /x && git reset --hard',
  ]) {
    const d = bash(c);
    assert.equal(d?.kind, 'ask', `expected ask for: ${c}`);
    assert.match(d.reason, /cc-harness git guard/);
  }
});

test('ordinary git commands pass', () => {
  for (const c of [
    'git status', 'git reset HEAD~1', 'git reset --soft HEAD~1', 'git checkout -b feature', 'git checkout main',
    'git restore --staged a.ts', 'git clean -n', 'git push', 'git push --force-with-lease', 'git branch -d merged',
    'git stash', 'git stash pop', 'git log --oneline', 'echo "git reset --hard"',
  ]) {
    assert.equal(bash(c), null, `expected pass for: ${c}`);
  }
});

test('non-Bash tools are ignored', () => {
  assert.equal(evaluate({ event: 'PreToolUse', input: { tool_name: 'Edit', tool_input: {} }, config: DEFAULTS, projectDir: '/p' }), null);
});
```

- [ ] **Step 6: Run to verify failure**

Run: `node --test test/guard-git.test.mjs`
Expected: FAIL, cannot find module `guards/git.mjs`.

- [ ] **Step 7: Implement guards/git.mjs**

```js
import { splitSegments, tokenize, resolveTool } from '../shell.mjs';
import { ask } from '../hook-io.mjs';

export const name = 'git';
export const event = 'PreToolUse';

const SHORT_F = /^-[a-zA-Z]*f[a-zA-Z]*$/;   // -f, -fd, -fdx, -uf ...
const RULES = [
  { when: (s, a) => s === 'reset' && a.includes('--hard'), what: 'discards every uncommitted change in the working tree' },
  { when: (s, a) => s === 'checkout' && (a.includes('.') || (a.includes('--') && a.length > a.indexOf('--') + 1)), what: 'overwrites working-tree files with the committed version' },
  { when: (s, a) => s === 'restore' && a.includes('.') && !a.includes('--staged'), what: 'overwrites working-tree files with the committed version' },
  { when: (s, a) => s === 'clean' && a.some((t) => t === '--force' || SHORT_F.test(t)), what: 'deletes untracked files' },
  { when: (s, a) => s === 'push' && a.some((t) => t === '--force' || SHORT_F.test(t)), what: 'rewrites remote history (use --force-with-lease if a force push is intended)' },
  { when: (s, a) => s === 'branch' && a.includes('-D'), what: 'deletes a branch even if it is unmerged' },
  { when: (s, a) => s === 'stash' && (a[0] === 'drop' || a[0] === 'clear'), what: 'discards stashed changes' },
];

// git [global opts] <subcommand> [args]; global opts like -C <dir> and -c k=v take a value
function splitGit(args) {
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) {
    if (args[i] === '-C' || args[i] === '-c') i += 2; else i += 1;
  }
  return { sub: args[i] ?? '', rest: args.slice(i + 1) };
}

export function evaluate({ input, config }) {
  if (input.tool_name !== 'Bash') return null;
  const command = typeof input.tool_input?.command === 'string' ? input.tool_input.command : '';
  for (const seg of splitSegments(command)) {
    const tw = resolveTool(tokenize(seg), config.commands.runnerWrappers);
    if (tw.word !== 'git') continue;
    const { sub, rest } = splitGit(tw.args);
    for (const r of RULES) {
      if (r.when(sub, rest)) return ask(`cc-harness git guard: "${seg}" ${r.what}. Confirm before running it.`);
    }
  }
  return null;
}
```

- [ ] **Step 8: Run git-guard tests**

Run: `node --test test/guard-git.test.mjs`
Expected: PASS.

- [ ] **Step 9: Write the failing CLI hook-dispatch test**

`test/cli-hook.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeProject, makeDataDir } from './helpers/project.mjs';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'cc-harness', 'bin', 'harness.mjs');

export function runHookCli(event, input, { projectDir, dataDir, env = {} } = {}) {
  const r = spawnSync(process.execPath, [BIN, 'hook', event], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir, CLAUDE_PLUGIN_DATA: dataDir ?? '', ...env },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json: r.stdout.trim() ? JSON.parse(r.stdout) : null };
}

const CFG = { version: 1, project: { testGlobs: ['**/*.test.*'] } };

test('no config → silent exit 0 for every event', () => {
  const p = makeProject({ files: { 'x.test.ts': '' } });
  try {
    for (const ev of ['PreToolUse', 'PostToolUse', 'Stop', 'SessionStart']) {
      const r = runHookCli(ev, { tool_name: 'Bash', tool_input: { command: 'rm x.test.ts' }, session_id: 's1' }, { projectDir: p.dir });
      assert.equal(r.status, 0, ev); assert.equal(r.stdout, '', ev);
    }
  } finally { p.cleanup(); }
});

test('marker file configured but absent → silent', () => {
  const p = makeProject({ config: { ...CFG, project: { ...CFG.project, markerFile: 'package.json' } }, files: { 'x.test.ts': '' } });
  try {
    const r = runHookCli('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'rm x.test.ts' } }, { projectDir: p.dir });
    assert.equal(r.status, 0); assert.equal(r.stdout, '');
  } finally { p.cleanup(); }
});

test('PreToolUse emits the ask JSON shape; deny beats ask', () => {
  const p = makeProject({ config: CFG, files: { 'x.test.ts': '' } });
  try {
    const r = runHookCli('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'rm x.test.ts' } }, { projectDir: p.dir });
    assert.equal(r.status, 0);
    assert.equal(r.json.hookSpecificOutput.permissionDecision, 'ask');
    assert.equal(r.json.hookSpecificOutput.hookEventName, 'PreToolUse');
  } finally { p.cleanup(); }
});

test('invalid config → PreToolUse asks with the error, other events write stderr and exit 0', () => {
  const p = makeProject({ files: { '.claude/harness.json': '{"version": 9}' } });
  try {
    const a = runHookCli('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }, { projectDir: p.dir });
    assert.equal(a.json.hookSpecificOutput.permissionDecision, 'ask');
    assert.match(a.json.hookSpecificOutput.permissionDecisionReason, /version must be 1/);
    const b = runHookCli('PostToolUse', { tool_name: 'Edit', tool_input: { file_path: 'a.ts' } }, { projectDir: p.dir });
    assert.equal(b.status, 0); assert.equal(b.stdout, ''); assert.match(b.stderr, /version must be 1/);
  } finally { p.cleanup(); }
});

test('empty or non-JSON stdin → silent exit 0', () => {
  const p = makeProject({ config: CFG });
  try {
    const r = spawnSync(process.execPath, [BIN, 'hook', 'PreToolUse'], { input: '', encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: p.dir } });
    assert.equal(r.status, 0); assert.equal(r.stdout, '');
  } finally { p.cleanup(); }
});
```

- [ ] **Step 10: Run to verify failure**

Run: `node --test test/cli-hook.test.mjs`
Expected: the "PreToolUse emits ask" and "invalid config" tests FAIL (stub prints nothing).

- [ ] **Step 11: Implement guards/index.mjs and the real runHook in cli.mjs**

`lib/guards/index.mjs`:
```js
import * as testGuard from './test.mjs';
import * as gitGuard from './git.mjs';

// T3 adds commitGuard, T4 adds qualityGuard and stopGuard, T5 adds preflightGuard.
export const GUARDS = [testGuard, gitGuard];

export function guardsFor(event) {
  return GUARDS.filter((g) => g.event === event);
}
```

Replace `runHook` in `lib/cli.mjs`:
```js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJson, toHookJson, pickDecision, ask } from './hook-io.mjs';
import { loadConfig, isGuardEnabled } from './config.mjs';
import { guardsFor } from './guards/index.mjs';
import { pluginRoot, pluginVersion } from './meta.mjs';

const EVENTS = new Set(['PreToolUse', 'PostToolUse', 'Stop', 'SessionStart']);

export async function runHook(event, io, overrides = {}) {
  if (!EVENTS.has(event)) { io.stderr.write(`harness: unknown hook event "${event}"\n`); return 1; }
  const input = await readJson(io.stdin);
  if (!input) return 0;
  const projectDir = io.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  const loaded = loadConfig(projectDir, overrides.presetsDir ? { presetsDir: overrides.presetsDir } : {});
  if (loaded.status === 'absent') return 0;
  if (loaded.status === 'invalid') {
    const msg = `cc-harness: .claude/harness.json is invalid; guards are inactive until it is fixed.\n- ${loaded.errors.join('\n- ')}`;
    if (event === 'PreToolUse') emit(io, toHookJson(event, ask(msg)));
    else if (event === 'SessionStart') io.stdout.write(msg + '\n');
    else io.stderr.write(msg + '\n');
    return 0;
  }
  const config = loaded.config;
  if (config.project.markerFile && !fs.existsSync(path.join(projectDir, config.project.markerFile))) return 0;

  const ctx = {
    event, input, config, projectDir,
    dataDir: overrides.dataDir || io.env.CLAUDE_PLUGIN_DATA || path.join(os.tmpdir(), 'cc-harness'),
    pluginRoot: pluginRoot(),
    exec: overrides.exec,          // T4 provides defaultExec; undefined until then
    fs,
    now: () => Date.now(),
  };
  const decisions = [];
  for (const g of guardsFor(event)) {
    if (!isGuardEnabled(config, g.name) && !g.alwaysRun) continue;
    try {
      decisions.push(g.evaluate(ctx));
    } catch (e) {
      io.stderr.write(`cc-harness: guard "${g.name}" crashed: ${e.stack || e}\n`);
      if (event === 'PreToolUse') decisions.push(ask(`cc-harness: guard "${g.name}" crashed (${e.message}); confirm manually.`));
    }
  }
  const d = pickDecision(decisions);
  if (!d) return 0;
  if (d.kind === 'context') { io.stdout.write(d.reason.endsWith('\n') ? d.reason : d.reason + '\n'); return 0; }
  emit(io, toHookJson(event, d));
  return 0;
}

function emit(io, obj) { if (obj) io.stdout.write(JSON.stringify(obj) + '\n'); }
```
Keep the `run()` switch; the `version` case now uses `pluginVersion()`.

- [ ] **Step 12: Run the whole suite**

Run: `node --test test/*.test.mjs`
Expected: all PASS.

- [ ] **Step 13: Commit**

```bash
git add -A
git commit -m "feat(guards): add test guard, git guard, and PreToolUse dispatch"
```

---

### Task 3: Commit guard, commit-msg git hook, regex file template

**Files:**
- Create: `plugins/cc-harness/lib/guards/commit.mjs`
- Create: `plugins/cc-harness/lib/commit-rules.mjs`
- Create: `plugins/cc-harness/templates/githooks/commit-msg`
- Create: `plugins/cc-harness/templates/githooks/conventional-regex.txt.tmpl`
- Modify: `plugins/cc-harness/lib/guards/index.mjs` (add commit guard)
- Test: `test/commit-rules.test.mjs`, `test/guard-commit.test.mjs`, `test/commit-msg-hook.test.mjs`

**Interfaces:**
- Produces (commit-rules): `parseRegexFile(text) → { regex: RegExp|null, types: string[], scopes: string[], error?: string }`; `extractCommitMessage(rawCommand, segment, tokens, readFile) → string|null` (null = no message in the command, e.g. `--amend` or editor); `checkMessage(message, rules, {rejectAttributionTrailers}) → string[]` errors; `TRAILER_PATTERNS`.
- Produces (regex file format, frozen): line 1 = the regex (ERE and JS compatible); optional `# types: a b c` and `# scopes: a b` comment lines after it.

- [ ] **Step 1: Write failing commit-rules tests**

`test/commit-rules.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRegexFile, extractCommitMessage, checkMessage } from '../plugins/cc-harness/lib/commit-rules.mjs';
import { splitSegments, tokenize } from '../plugins/cc-harness/lib/shell.mjs';

const FILE = `^(feat|fix|docs)(\\((cli|guards)\\))?!?: [a-z](.{0,64}[^.])?$
# types: feat fix docs
# scopes: cli guards
`;

test('parseRegexFile reads line 1 and the comment lines', () => {
  const r = parseRegexFile(FILE);
  assert.ok(r.regex instanceof RegExp);
  assert.deepEqual(r.types, ['feat', 'fix', 'docs']);
  assert.deepEqual(r.scopes, ['cli', 'guards']);
  assert.deepEqual(parseRegexFile('^x$\n').types, []);
  assert.equal(parseRegexFile('').regex, null);
  assert.match(parseRegexFile('(').error, /invalid/i);
});

function extract(cmd) {
  const seg = splitSegments(cmd).find((s) => /\bgit\b.*\bcommit\b/.test(s));
  return extractCommitMessage(cmd, seg, tokenize(seg), () => { throw new Error('no file'); });
}

test('extractCommitMessage handles -m, multiple -m, --message=, -F file, heredoc, and none', () => {
  assert.equal(extract('git commit -m "feat: add x"'), 'feat: add x');
  assert.equal(extract("git commit -m 'feat: add x' -m 'body here'"), 'feat: add x\n\nbody here');
  assert.equal(extract('git commit --message="fix: y"'), 'fix: y');
  assert.equal(extract('git commit -am "fix: y"'), 'fix: y');
  assert.equal(extract('git commit -F - <<\'EOF\'\nfeat: z\n\nbody\nEOF'), 'feat: z\n\nbody');
  assert.equal(extract('git commit -F - <<EOF\nfeat: z\nEOF'), 'feat: z');
  assert.equal(extract('git commit --amend --no-edit'), null);
  assert.equal(extract('git commit'), null);
  const seg = 'git commit -F msg.txt';
  assert.equal(extractCommitMessage(seg, seg, tokenize(seg), (f) => (f === 'msg.txt' ? 'docs: from file\n' : null)), 'docs: from file');
});

test('checkMessage validates subject and trailers', () => {
  const rules = parseRegexFile(FILE);
  assert.deepEqual(checkMessage('feat(cli): add thing', rules, { rejectAttributionTrailers: true }), []);
  assert.match(checkMessage('update code', rules, { rejectAttributionTrailers: true })[0], /subject/);
  assert.match(checkMessage('feat: Add thing.', rules, { rejectAttributionTrailers: true })[0], /subject/);
  assert.match(checkMessage('feat: ok\n\nCo-Authored-By: X <x@y>', rules, { rejectAttributionTrailers: true })[0], /attribution/);
  assert.match(checkMessage('feat: ok\n\nClaude-Session: https://x', rules, { rejectAttributionTrailers: true })[0], /attribution/);
  assert.match(checkMessage('feat: ok\n\n🤖 Generated with [Claude Code](https://claude.com)', rules, { rejectAttributionTrailers: true })[0], /attribution/);
  assert.deepEqual(checkMessage('feat: ok\n\nCo-Authored-By: X <x@y>', rules, { rejectAttributionTrailers: false }), []);
  assert.match(checkMessage('feat: ok', { regex: null, types: [], scopes: [], error: 'x' }, {})[0], /regex file/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/commit-rules.test.mjs`
Expected: FAIL, cannot find module `commit-rules.mjs`.

- [ ] **Step 3: Implement commit-rules.mjs**

```js
export const TRAILER_PATTERNS = [
  /^co-authored-by:/im,
  /^claude-session:/im,
  /generated with .*claude/i,
];

export function parseRegexFile(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const line1 = (lines[0] ?? '').trim();
  const grab = (label) => {
    const l = lines.find((x) => x.startsWith(`# ${label}:`));
    return l ? l.slice(label.length + 3).trim().split(/\s+/).filter(Boolean) : [];
  };
  const out = { regex: null, types: grab('types'), scopes: grab('scopes') };
  if (!line1) return { ...out, error: 'regex file is empty' };
  try { out.regex = new RegExp(line1); } catch (e) { out.error = `invalid regex on line 1: ${e.message}`; }
  return out;
}

const HEREDOC = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*\n([\s\S]*?)\n\s*\2\s*$/m;

// Returns the commit message text, or null when the command carries no inline message.
export function extractCommitMessage(rawCommand, segment, tokens, readFile) {
  const parts = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '-m' || t === '--message') { if (i + 1 < tokens.length) parts.push(tokens[++i]); continue; }
    if (t.startsWith('--message=')) { parts.push(t.slice('--message='.length)); continue; }
    if (/^-[a-zA-Z]*m$/.test(t)) { if (i + 1 < tokens.length) parts.push(tokens[++i]); continue; }   // -am, -sm
    if (t === '-F' || t === '--file') {
      const f = tokens[i + 1];
      if (f === '-') { const m = HEREDOC.exec(rawCommand); return m ? m[3] : null; }
      if (f) { const body = readFile(f); return body === null || body === undefined ? null : String(body).replace(/\s+$/, ''); }
    }
    if (t.startsWith('--file=')) { const body = readFile(t.slice(7)); return body == null ? null : String(body).replace(/\s+$/, ''); }
  }
  return parts.length ? parts.join('\n\n') : null;
}

export function checkMessage(message, rules, { rejectAttributionTrailers = true } = {}) {
  const errors = [];
  if (!rules.regex) {
    errors.push(`the commit regex file could not be used (${rules.error ?? 'missing'}); fix it before committing`);
    return errors;
  }
  const subject = message.split(/\r?\n/)[0] ?? '';
  if (!rules.regex.test(subject)) {
    let hint = `subject "${subject}" does not match ${rules.regex.source}`;
    if (rules.types.length) hint += `\n  allowed types: ${rules.types.join(' ')}`;
    if (rules.scopes.length) hint += `\n  allowed scopes: ${rules.scopes.join(' ')}`;
    hint += '\n  expected: type(scope): lower-case imperative subject, no trailing period, ≤ 65 chars after the colon';
    errors.push(hint);
  }
  if (rejectAttributionTrailers && TRAILER_PATTERNS.some((re) => re.test(message))) {
    errors.push('attribution trailers (Co-Authored-By, Claude-Session, "Generated with") are not allowed in this repository');
  }
  return errors;
}
```

- [ ] **Step 4: Run commit-rules tests**

Run: `node --test test/commit-rules.test.mjs`
Expected: PASS.

- [ ] **Step 5: Write failing commit-guard tests**

`test/guard-commit.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../plugins/cc-harness/lib/guards/commit.mjs';
import { DEFAULTS, mergeConfig } from '../plugins/cc-harness/lib/config.mjs';
import { makeProject } from './helpers/project.mjs';

const REGEX = '^(feat|fix|docs)(\\((cli|guards)\\))?!?: [a-z](.{0,64}[^.])?$\n# types: feat fix docs\n# scopes: cli guards\n';
const files = { 'githooks/conventional-regex.txt': REGEX, 'msg.txt': 'feat: from file\n' };

function run(p, command, over = {}) {
  const config = mergeConfig(DEFAULTS, over);
  return evaluate({ event: 'PreToolUse', input: { tool_name: 'Bash', tool_input: { command } }, config, projectDir: p.dir });
}

test('valid commits pass', () => {
  const p = makeProject({ files });
  try {
    for (const c of ['git commit -m "feat: add x"', "git commit -am 'fix(cli): y'", 'git commit -F msg.txt', 'git commit --amend --no-edit', 'git commit', 'git status', 'echo git commit -m "bad"', 'git commit -F - <<\'EOF\'\nfeat(guards): z\nEOF']) {
      assert.equal(run(p, c), null, c);
    }
  } finally { p.cleanup(); }
});

test('invalid commits deny with the format hint', () => {
  const p = makeProject({ files });
  try {
    const d = run(p, 'git commit -m "update code"');
    assert.equal(d?.kind, 'deny');
    assert.match(d.reason, /allowed types: feat fix docs/);
    assert.equal(run(p, 'git add . && git commit -m "Feat: caps"')?.kind, 'deny');
    assert.equal(run(p, 'git commit -m "feat: ok" -m "Co-Authored-By: bot <b@x>"')?.kind, 'deny');
    assert.equal(run(p, 'git commit -F - <<EOF\nfeat: ok\n\nClaude-Session: https://x\nEOF')?.kind, 'deny');
    assert.equal(run(p, 'git commit -m "feat: ok" -m "Co-Authored-By: bot <b@x>"', { guards: { commit: { rejectAttributionTrailers: false } } }), null);
  } finally { p.cleanup(); }
});

test('missing regex file denies with a pointer', () => {
  const p = makeProject({ files: {} });
  try {
    const d = run(p, 'git commit -m "feat: x"');
    assert.equal(d?.kind, 'deny');
    assert.match(d.reason, /githooks\/conventional-regex\.txt/);
  } finally { p.cleanup(); }
});
```

- [ ] **Step 6: Run to verify failure**

Run: `node --test test/guard-commit.test.mjs`
Expected: FAIL, cannot find module `guards/commit.mjs`.

- [ ] **Step 7: Implement guards/commit.mjs and register it**

```js
import fs from 'node:fs';
import path from 'node:path';
import { splitSegments, tokenize, resolveTool } from '../shell.mjs';
import { deny } from '../hook-io.mjs';
import { parseRegexFile, extractCommitMessage, checkMessage } from '../commit-rules.mjs';

export const name = 'commit';
export const event = 'PreToolUse';

export function evaluate({ input, config, projectDir }) {
  if (input.tool_name !== 'Bash') return null;
  const command = typeof input.tool_input?.command === 'string' ? input.tool_input.command : '';
  const { regexFile, rejectAttributionTrailers } = config.guards.commit;
  for (const seg of splitSegments(command)) {
    const tokens = tokenize(seg);
    const tw = resolveTool(tokens, config.commands.runnerWrappers);
    if (tw.word !== 'git') continue;
    const sub = tw.args.find((a) => !a.startsWith('-'));
    if (sub !== 'commit') continue;
    const message = extractCommitMessage(command, seg, tokens, (f) => {
      const abs = path.resolve(projectDir, f);
      return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
    });
    if (message === null) continue;
    const regexPath = path.resolve(projectDir, regexFile);
    const rules = fs.existsSync(regexPath)
      ? parseRegexFile(fs.readFileSync(regexPath, 'utf8'))
      : { regex: null, types: [], scopes: [], error: `${regexFile} not found; run /cc-harness:init or create it` };
    const errors = checkMessage(message, rules, { rejectAttributionTrailers });
    if (errors.length) return deny(`cc-harness commit guard rejected the commit message:\n- ${errors.join('\n- ')}\nThe same rule is enforced by ${regexFile} in the git commit-msg hook and in CI.`);
  }
  return null;
}
```

In `lib/guards/index.mjs` add `import * as commitGuard from './commit.mjs';` and put it in `GUARDS` **before** `testGuard` (deny beats ask anyway, but ordering keeps output deterministic).

- [ ] **Step 8: Run commit-guard tests**

Run: `node --test test/guard-commit.test.mjs`
Expected: PASS.

- [ ] **Step 9: Write the commit-msg git hook template and regex template**

`plugins/cc-harness/templates/githooks/commit-msg` (static, copied verbatim by init; mode 0755):
```sh
#!/bin/sh
# cc-harness commit-msg hook. Enforces the regex in githooks/conventional-regex.txt.
# Usage: githooks/commit-msg <message-file>     (git calls it this way)
# Enable: git config core.hooksPath githooks
set -eu
root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
rules="$root/githooks/conventional-regex.txt"
msgfile="$1"

[ -f "$rules" ] || { echo "commit-msg: $rules not found" >&2; exit 1; }
regex=$(head -n 1 "$rules")
types=$(sed -n 's/^# types: //p' "$rules")
scopes=$(sed -n 's/^# scopes: //p' "$rules")
subject=$(grep -v '^#' "$msgfile" | sed -n '1p')

if ! printf '%s\n' "$subject" | grep -Eq "$regex"; then
  echo "commit-msg: subject \"$subject\" does not match the required format" >&2
  echo "  regex:  $regex" >&2
  [ -n "$types" ] && echo "  types:  $types" >&2
  [ -n "$scopes" ] && echo "  scopes: $scopes" >&2
  exit 1
fi

if [ "${CC_HARNESS_REJECT_TRAILERS:-1}" = "1" ] && grep -Eiq '^(co-authored-by|claude-session):|generated with .*claude' "$msgfile"; then
  echo "commit-msg: attribution trailers (Co-Authored-By, Claude-Session, Generated with) are not allowed" >&2
  exit 1
fi
exit 0
```

`plugins/cc-harness/templates/githooks/conventional-regex.txt.tmpl`:
```
{{COMMIT_REGEX}}
# types: {{COMMIT_TYPES}}
# scopes: {{COMMIT_SCOPES}}
```

- [ ] **Step 10: Write the failing commit-msg hook test**

`test/commit-msg-hook.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeProject } from './helpers/project.mjs';

const HOOK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'cc-harness', 'templates', 'githooks', 'commit-msg');
const REGEX = '^(feat|fix)(\\((cli)\\))?!?: [a-z](.{0,64}[^.])?$\n# types: feat fix\n# scopes: cli\n';

function runHook(p, message, env = {}) {
  const f = p.write('.git/COMMIT_EDITMSG', message);
  return spawnSync('/bin/sh', [HOOK, f], { cwd: p.dir, encoding: 'utf8', env: { ...process.env, ...env } });
}

test('commit-msg hook accepts and rejects like the guard', () => {
  const p = makeProject({ files: { 'githooks/conventional-regex.txt': REGEX } });
  try {
    spawnSync('git', ['init', '-q'], { cwd: p.dir });
    assert.equal(runHook(p, 'feat(cli): add x\n').status, 0);
    assert.equal(runHook(p, '# comment line\nfix: y\n').status, 0);
    const bad = runHook(p, 'update code\n');
    assert.equal(bad.status, 1); assert.match(bad.stderr, /types:  feat fix/);
    const trailer = runHook(p, 'feat: ok\n\nCo-Authored-By: x <x@y>\n');
    assert.equal(trailer.status, 1); assert.match(trailer.stderr, /attribution/);
    assert.equal(runHook(p, 'feat: ok\n\nCo-Authored-By: x <x@y>\n', { CC_HARNESS_REJECT_TRAILERS: '0' }).status, 0);
  } finally { p.cleanup(); }
});

test('under git with core.hooksPath the hook blocks a real commit', () => {
  const p = makeProject({ files: { 'githooks/conventional-regex.txt': REGEX, 'a.txt': 'a' } });
  try {
    fs.mkdirSync(path.join(p.dir, 'githooks'), { recursive: true });
    fs.copyFileSync(HOOK, path.join(p.dir, 'githooks/commit-msg'));
    fs.chmodSync(path.join(p.dir, 'githooks/commit-msg'), 0o755);
    const git = (...a) => spawnSync('git', a, { cwd: p.dir, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
    git('init', '-q'); git('config', 'core.hooksPath', 'githooks'); git('add', '.');
    assert.notEqual(git('commit', '-q', '-m', 'bad message').status, 0);
    assert.equal(git('commit', '-q', '-m', 'feat: good message').status, 0);
  } finally { p.cleanup(); }
});
```

- [ ] **Step 11: Run all tests**

Run: `chmod +x plugins/cc-harness/templates/githooks/commit-msg && node --test test/*.test.mjs`
Expected: all PASS.

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "feat(guards): add commit guard and commit-msg git hook"
```

---

### Task 4: Check runner, session markers, quality gate, stop gate

**Files:**
- Create: `plugins/cc-harness/lib/checks.mjs`
- Create: `plugins/cc-harness/lib/session.mjs`
- Create: `plugins/cc-harness/lib/guards/quality.mjs`
- Create: `plugins/cc-harness/lib/guards/stop.mjs`
- Modify: `plugins/cc-harness/lib/guards/index.mjs`, `plugins/cc-harness/lib/cli.mjs` (`exec: overrides.exec ?? defaultExec`)
- Test: `test/checks.test.mjs`, `test/session.test.mjs`, `test/guard-quality.test.mjs`, `test/guard-stop.test.mjs`

**Interfaces:**
- Produces (checks): `selectChecks(config, {scope}) → check[]` (`'fast'` = `fast:true` only, `'all'` = every check); `runChecks(checks, {projectDir, exec, fs}) → { ok:true, skipped:string[] } | { ok:false, failed:{name,cmd,status,output}, skipped }`; `defaultExec(cmd, {cwd}) → {status, output}`; `formatFailure(failed) → string`; `tail(text, n)`.
- Produces (session): `markerPath(dataDir, sessionId)`, `readMarker(dataDir, sessionId) → object|null`, `writeMarker(dataDir, sessionId, obj)`, `markDirty(dataDir, sessionId, relFile)`, `clearMarker(dataDir, sessionId)`, `pruneMarkers(dataDir, maxAgeMs, now) → number`. Marker shape: `{ dirty: boolean, blocks: number, files: string[], updatedAt: number }`.
- Quality guard exports `alwaysRun = true` so the dispatcher calls it even when disabled (it must still mark the session dirty); it checks `enabled` itself before running checks.

- [ ] **Step 1: Write failing checks tests**

`test/checks.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { selectChecks, runChecks, defaultExec, formatFailure, tail } from '../plugins/cc-harness/lib/checks.mjs';
import { DEFAULTS, mergeConfig } from '../plugins/cc-harness/lib/config.mjs';
import { makeProject } from './helpers/project.mjs';

const cfg = mergeConfig(DEFAULTS, { checks: [
  { name: 'a', cmd: 'true', fast: true }, { name: 'b', cmd: 'true' }, { name: 'c', cmd: 'echo boom; exit 3', fast: true, ifExists: 'marker' },
] });

test('selectChecks by scope', () => {
  assert.deepEqual(selectChecks(cfg, { scope: 'fast' }).map((c) => c.name), ['a', 'c']);
  assert.deepEqual(selectChecks(cfg, { scope: 'all' }).map((c) => c.name), ['a', 'b', 'c']);
});

test('runChecks: sequential, stops at first failure, honours ifExists', () => {
  const p = makeProject({});
  try {
    const r1 = runChecks(cfg.checks, { projectDir: p.dir, exec: defaultExec, fs });
    assert.deepEqual(r1, { ok: true, skipped: ['c'] });
    p.write('marker', '');
    const r2 = runChecks(cfg.checks, { projectDir: p.dir, exec: defaultExec, fs });
    assert.equal(r2.ok, false);
    assert.equal(r2.failed.name, 'c'); assert.equal(r2.failed.status, 3); assert.match(r2.failed.output, /boom/);
  } finally { p.cleanup(); }
});

test('exec is injectable and cwd is the project dir', () => {
  const calls = [];
  const exec = (cmd, { cwd }) => { calls.push([cmd, cwd]); return { status: 0, output: '' }; };
  runChecks([{ name: 'x', cmd: 'pwd' }], { projectDir: '/p', exec, fs });
  assert.deepEqual(calls, [['pwd', '/p']]);
});

test('tail and formatFailure', () => {
  assert.equal(tail('1\n2\n3\n', 2), '2\n3');
  const s = formatFailure({ name: 'lint', cmd: 'eslint .', status: 1, output: 'x' });
  assert.match(s, /check "lint" failed \(exit 1\): eslint \./);
  assert.match(s, /Fix this before continuing\. Do not start new work\./);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/checks.test.mjs`
Expected: FAIL, cannot find module `checks.mjs`.

- [ ] **Step 3: Implement checks.mjs**

```js
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const OUTPUT_LINES = 60;

export function selectChecks(config, { scope = 'fast' } = {}) {
  return scope === 'all' ? config.checks : config.checks.filter((c) => c.fast === true);
}

export function defaultExec(cmd, { cwd, timeoutMs = 540_000 } = {}) {
  const r = spawnSync('/bin/sh', ['-c', cmd], {
    cwd, encoding: 'utf8', timeout: timeoutMs,
    env: { ...process.env, CI: process.env.CI ?? '1', FORCE_COLOR: '0', NO_COLOR: '1' },
    maxBuffer: 16 * 1024 * 1024,
  });
  const output = (r.stdout ?? '') + (r.stderr ?? '') + (r.error ? `\n${r.error.message}` : '');
  return { status: r.status ?? 1, output };
}

export function runChecks(checks, { projectDir, exec, fs }) {
  const skipped = [];
  for (const c of checks) {
    if (c.ifExists && !fs.existsSync(path.resolve(projectDir, c.ifExists))) { skipped.push(c.name); continue; }
    const r = exec(c.cmd, { cwd: projectDir });
    if (r.status !== 0) return { ok: false, failed: { name: c.name, cmd: c.cmd, status: r.status, output: tail(r.output, OUTPUT_LINES) }, skipped };
  }
  return { ok: true, skipped };
}

export function tail(text, n) {
  const lines = String(text ?? '').replace(/\s+$/, '').split('\n');
  return lines.slice(-n).join('\n');
}

export function formatFailure(f) {
  return `cc-harness check "${f.name}" failed (exit ${f.status}): ${f.cmd}\n${f.output}\nFix this before continuing. Do not start new work.`;
}
```

- [ ] **Step 4: Run checks tests**

Run: `node --test test/checks.test.mjs`
Expected: PASS.

- [ ] **Step 5: Write failing session tests**

`test/session.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { markerPath, readMarker, writeMarker, markDirty, clearMarker, pruneMarkers } from '../plugins/cc-harness/lib/session.mjs';
import { makeDataDir } from './helpers/project.mjs';

test('marker lifecycle', () => {
  const d = makeDataDir();
  try {
    assert.equal(readMarker(d.dir, 's1'), null);
    markDirty(d.dir, 's1', 'src/a.ts');
    markDirty(d.dir, 's1', 'src/a.ts');
    markDirty(d.dir, 's1', 'src/b.ts');
    const m = readMarker(d.dir, 's1');
    assert.equal(m.dirty, true); assert.equal(m.blocks, 0); assert.deepEqual(m.files, ['src/a.ts', 'src/b.ts']);
    writeMarker(d.dir, 's1', { ...m, blocks: 2 });
    assert.equal(readMarker(d.dir, 's1').blocks, 2);
    assert.equal(readMarker(d.dir, 's2'), null);           // sessions are isolated
    clearMarker(d.dir, 's1'); clearMarker(d.dir, 's1');    // idempotent
    assert.equal(readMarker(d.dir, 's1'), null);
    assert.match(markerPath(d.dir, '../../evil'), /sessions\/[A-Za-z0-9_.-]+\.json$/);
    assert.ok(!markerPath(d.dir, '../../evil').includes('..'));
  } finally { d.cleanup(); }
});

test('pruneMarkers removes old files only', () => {
  const d = makeDataDir();
  try {
    markDirty(d.dir, 'old', 'x'); markDirty(d.dir, 'new', 'y');
    const oldPath = markerPath(d.dir, 'old');
    const past = new Date(Date.now() - 10 * 86400e3);
    fs.utimesSync(oldPath, past, past);
    assert.equal(pruneMarkers(d.dir, 7 * 86400e3), 1);
    assert.equal(readMarker(d.dir, 'old'), null); assert.notEqual(readMarker(d.dir, 'new'), null);
    assert.equal(pruneMarkers('/nonexistent/dir', 1), 0);
  } finally { d.cleanup(); }
});
```

- [ ] **Step 6: Run to verify failure**

Run: `node --test test/session.test.mjs`
Expected: FAIL, cannot find module `session.mjs`.

- [ ] **Step 7: Implement session.mjs**

```js
import fs from 'node:fs';
import path from 'node:path';

const safeId = (id) => String(id).replace(/[^A-Za-z0-9_.-]/g, '_').replace(/\.\.+/g, '_') || 'unknown';

export function markerPath(dataDir, sessionId) {
  return path.join(dataDir, 'sessions', `${safeId(sessionId)}.json`);
}

export function readMarker(dataDir, sessionId) {
  const f = markerPath(dataDir, sessionId);
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}

export function writeMarker(dataDir, sessionId, marker) {
  const f = markerPath(dataDir, sessionId);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ ...marker, updatedAt: Date.now() }));
}

export function markDirty(dataDir, sessionId, relFile) {
  const m = readMarker(dataDir, sessionId) ?? { dirty: false, blocks: 0, files: [] };
  m.dirty = true;
  if (relFile && !m.files.includes(relFile)) m.files.push(relFile);
  writeMarker(dataDir, sessionId, m);
}

export function clearMarker(dataDir, sessionId) {
  fs.rmSync(markerPath(dataDir, sessionId), { force: true });
}

export function pruneMarkers(dataDir, maxAgeMs, now = Date.now()) {
  const dir = path.join(dataDir, 'sessions');
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    try { if (now - fs.statSync(p).mtimeMs > maxAgeMs) { fs.rmSync(p, { force: true }); n++; } } catch { /* ignore */ }
  }
  return n;
}
```

- [ ] **Step 8: Run session tests**

Run: `node --test test/session.test.mjs`
Expected: PASS.

- [ ] **Step 9: Write failing quality-gate tests**

`test/guard-quality.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { evaluate } from '../plugins/cc-harness/lib/guards/quality.mjs';
import { readMarker } from '../plugins/cc-harness/lib/session.mjs';
import { DEFAULTS, mergeConfig } from '../plugins/cc-harness/lib/config.mjs';
import { makeProject, makeDataDir } from './helpers/project.mjs';

const base = {
  project: { sourceGlobs: ['**/*.ts'], testGlobs: ['**/*.test.ts'] },
  checks: [{ name: 'fastfail', cmd: 'echo nope; exit 1', fast: true }, { name: 'slow', cmd: 'exit 2' }],
};
const fakeExec = (log) => (cmd, { cwd }) => { log.push(cmd); return cmd.includes('exit 1') ? { status: 1, output: 'nope' } : cmd.includes('exit 2') ? { status: 2, output: 'slow' } : { status: 0, output: '' }; };

function run(p, d, file, over = {}, log = []) {
  const config = mergeConfig(mergeConfig(DEFAULTS, base), over);
  const input = { tool_name: 'Edit', tool_input: { file_path: path.join(p.dir, file) }, session_id: 'sess' };
  return { d: evaluate({ event: 'PostToolUse', input, config, projectDir: p.dir, dataDir: d.dir, exec: fakeExec(log), fs }), log };
}

test('source edit: marks dirty, runs fast checks, blocks on failure', () => {
  const p = makeProject({}); const d = makeDataDir();
  try {
    const { d: dec, log } = run(p, d, 'src/a.ts');
    assert.equal(dec?.kind, 'block'); assert.match(dec.reason, /check "fastfail" failed/); assert.match(dec.reason, /Do not start new work/);
    assert.deepEqual(log, ['echo nope; exit 1']);
    assert.deepEqual(readMarker(d.dir, 'sess').files, ['src/a.ts']);
  } finally { p.cleanup(); d.cleanup(); }
});

test('scope all runs every check; passing checks are silent', () => {
  const p = makeProject({}); const d = makeDataDir();
  try {
    const { log } = run(p, d, 'src/a.ts', { guards: { quality: { scope: 'all' } }, checks: [{ name: 'ok', cmd: 'true', fast: true }, { name: 'ok2', cmd: 'true' }] });
    assert.deepEqual(log, ['true', 'true']);
    const { d: dec } = run(p, d, 'src/a.test.ts', { checks: [{ name: 'ok', cmd: 'true', fast: true }] });
    assert.equal(dec, null);
  } finally { p.cleanup(); d.cleanup(); }
});

test('non-source paths and ignored paths do nothing', () => {
  const p = makeProject({}); const d = makeDataDir();
  try {
    assert.equal(run(p, d, 'README.md').d, null);
    assert.equal(run(p, d, 'node_modules/x/a.ts').d, null);
    assert.equal(readMarker(d.dir, 'sess'), null);
  } finally { p.cleanup(); d.cleanup(); }
});

test('disabled quality gate still marks dirty but runs nothing', () => {
  const p = makeProject({}); const d = makeDataDir();
  try {
    const { d: dec, log } = run(p, d, 'src/a.ts', { guards: { quality: { enabled: false } } });
    assert.equal(dec, null); assert.deepEqual(log, []);
    assert.equal(readMarker(d.dir, 'sess').dirty, true);
  } finally { p.cleanup(); d.cleanup(); }
});
```

- [ ] **Step 10: Run to verify failure**

Run: `node --test test/guard-quality.test.mjs`
Expected: FAIL, cannot find module `guards/quality.mjs`.

- [ ] **Step 11: Implement guards/quality.mjs**

```js
import { matchesAny } from '../glob.mjs';
import { relTo, isGuardEnabled } from '../config.mjs';
import { block } from '../hook-io.mjs';
import { selectChecks, runChecks, formatFailure } from '../checks.mjs';
import { markDirty } from '../session.mjs';

export const name = 'quality';
export const event = 'PostToolUse';
export const alwaysRun = true;   // must mark the session dirty even when disabled

export function evaluate({ input, config, projectDir, dataDir, exec, fs }) {
  const fp = input.tool_input?.file_path;
  if (typeof fp !== 'string' || !fp) return null;
  const rel = relTo(projectDir, fp);
  const { sourceGlobs, testGlobs, ignoreGlobs } = config.project;
  if (matchesAny(rel, ignoreGlobs)) return null;
  if (!matchesAny(rel, sourceGlobs) && !matchesAny(rel, testGlobs)) return null;
  if (input.session_id) markDirty(dataDir, input.session_id, rel);
  if (!isGuardEnabled(config, 'quality')) return null;
  const r = runChecks(selectChecks(config, { scope: config.guards.quality.scope }), { projectDir, exec, fs });
  return r.ok ? null : block(formatFailure(r.failed));
}
```

- [ ] **Step 12: Write failing stop-gate tests**

`test/guard-stop.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { evaluate } from '../plugins/cc-harness/lib/guards/stop.mjs';
import { markDirty, readMarker } from '../plugins/cc-harness/lib/session.mjs';
import { DEFAULTS, mergeConfig } from '../plugins/cc-harness/lib/config.mjs';
import { makeProject, makeDataDir } from './helpers/project.mjs';

const cfg = () => mergeConfig(DEFAULTS, {
  checks: [{ name: 'typecheck', cmd: 'tc', fast: true }, { name: 'test', cmd: 'tests' }, { name: 'lint', cmd: 'lint', fast: true }],
  guards: { stop: { checks: ['typecheck', 'test'], maxBlocks: 2 } },
});
const execFailing = (set) => (cmd) => (set.has(cmd) ? { status: 1, output: `${cmd} failed` } : { status: 0, output: '' });

function run(p, d, config, exec, sid = 'sess') {
  return evaluate({ event: 'Stop', input: { session_id: sid, stop_hook_active: true }, config, projectDir: p.dir, dataDir: d.dir, exec, fs });
}

test('no marker → null; clean checks → clears marker', () => {
  const p = makeProject({}); const d = makeDataDir();
  try {
    assert.equal(run(p, d, cfg(), execFailing(new Set())), null);
    markDirty(d.dir, 'sess', 'a.ts');
    assert.equal(run(p, d, cfg(), execFailing(new Set())), null);
    assert.equal(readMarker(d.dir, 'sess'), null);
  } finally { p.cleanup(); d.cleanup(); }
});

test('failing named check blocks up to maxBlocks, then warns and releases', () => {
  const p = makeProject({}); const d = makeDataDir();
  try {
    markDirty(d.dir, 'sess', 'a.ts');
    const exec = execFailing(new Set(['tests']));
    const b1 = run(p, d, cfg(), exec); assert.equal(b1.kind, 'block'); assert.match(b1.reason, /stop gate \(1\/2\)/); assert.match(b1.reason, /check "test" failed/);
    const b2 = run(p, d, cfg(), exec); assert.equal(b2.kind, 'block'); assert.match(b2.reason, /\(2\/2\)/);
    const w = run(p, d, cfg(), exec); assert.equal(w.kind, 'warn'); assert.match(w.reason, /released after 2 blocks/); assert.match(w.reason, /"test"/);
    assert.equal(readMarker(d.dir, 'sess'), null);
    assert.equal(run(p, d, cfg(), exec), null);   // nothing dirty any more
  } finally { p.cleanup(); d.cleanup(); }
});

test('only the named stop checks run; lint is never invoked', () => {
  const p = makeProject({}); const d = makeDataDir();
  try {
    markDirty(d.dir, 'sess', 'a.ts');
    const log = []; const exec = (cmd) => { log.push(cmd); return { status: 0, output: '' }; };
    run(p, d, cfg(), exec);
    assert.deepEqual(log, ['tc', 'tests']);
  } finally { p.cleanup(); d.cleanup(); }
});

test('sessions are isolated', () => {
  const p = makeProject({}); const d = makeDataDir();
  try {
    markDirty(d.dir, 'other', 'a.ts');
    assert.equal(run(p, d, cfg(), execFailing(new Set(['tests'])), 'sess'), null);
  } finally { p.cleanup(); d.cleanup(); }
});
```

- [ ] **Step 13: Implement guards/stop.mjs, register both guards, wire defaultExec**

`lib/guards/stop.mjs`:
```js
import { checksByName } from '../config.mjs';
import { block, warn } from '../hook-io.mjs';
import { runChecks, formatFailure } from '../checks.mjs';
import { readMarker, writeMarker, clearMarker } from '../session.mjs';

export const name = 'stop';
export const event = 'Stop';

export function evaluate({ input, config, projectDir, dataDir, exec, fs }) {
  const sid = input.session_id;
  if (!sid) return null;
  const marker = readMarker(dataDir, sid);
  if (!marker || !marker.dirty) return null;
  const { checks: names, maxBlocks } = config.guards.stop;
  const r = runChecks(checksByName(config, names), { projectDir, exec, fs });
  if (r.ok) { clearMarker(dataDir, sid); return null; }
  const blocks = (marker.blocks ?? 0) + 1;
  if (blocks <= maxBlocks) {
    writeMarker(dataDir, sid, { ...marker, blocks });
    return block(`cc-harness stop gate (${blocks}/${maxBlocks}): the definition of done is not met.\n${formatFailure(r.failed)}`);
  }
  clearMarker(dataDir, sid);
  return warn(`cc-harness: stop gate released after ${maxBlocks} blocks; check "${r.failed.name}" is still failing.`);
}
```

`lib/guards/index.mjs`: import `qualityGuard` and `stopGuard`, `GUARDS = [commitGuard, testGuard, gitGuard, qualityGuard, stopGuard]`.

`lib/cli.mjs`: `import { defaultExec } from './checks.mjs';` and set `exec: overrides.exec ?? defaultExec`.

- [ ] **Step 14: Run the whole suite**

Run: `node --test test/*.test.mjs`
Expected: all PASS.

- [ ] **Step 15: Commit**

```bash
git add -A
git commit -m "feat(guards): add quality gate and stop gate with session markers"
```

---

### Task 5: Doctor and SessionStart preflight

**Files:**
- Create: `plugins/cc-harness/lib/doctor.mjs`
- Create: `plugins/cc-harness/lib/guards/preflight.mjs`
- Modify: `plugins/cc-harness/lib/guards/index.mjs`, `plugins/cc-harness/lib/cli.mjs` (`runDoctor`)
- Test: `test/doctor.test.mjs`, `test/guard-preflight.test.mjs`

**Interfaces:**
- Produces (doctor): `diagnose({ projectDir, loaded, exec, fs, pluginVersion, nodeVersion }) → { findings: [{level:'ok'|'warn'|'error', text}], summary: string }` where `loaded` is a `loadConfig()` result; `formatStatus(report, { pluginVersion, config }) → string` (the five-line block). `RULE_NAMES = ['testing','done','commits','models','harness']` and `ruleStamp(text) → string|null` (reads `<!-- cc-harness: v0.1.0 -->` from a rules file header; the T6 templates emit exactly that line first).
- Produces (preflight guard): `name='preflight'`, `event='SessionStart'`, `evaluate(ctx) → context(text)`; on `input.source === 'startup'` prunes markers older than 7 days.

- [ ] **Step 1: Write failing doctor tests**

`test/doctor.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { diagnose, formatStatus, ruleStamp, RULE_NAMES } from '../plugins/cc-harness/lib/doctor.mjs';
import { loadConfig } from '../plugins/cc-harness/lib/config.mjs';
import { makeProject } from './helpers/project.mjs';

const REGEX = '^(feat|fix)(\\((cli)\\))?!?: [a-z](.{0,64}[^.])?$\n# types: feat fix\n# scopes: cli\n';
const rules = Object.fromEntries(RULE_NAMES.map((n) => [`.claude/rules/harness-${n}.md`, '<!-- cc-harness: v0.1.0 -->\n# x\n']));
const config = { version: 1, project: { markerFile: 'package.json', sourceGlobs: ['**/*.ts'], testGlobs: ['**/*.test.ts'] }, checks: [{ name: 'tc', cmd: 'true', ifExists: 'tsconfig.json', fast: true }, { name: 'test', cmd: 'true' }], guards: { stop: { checks: ['test'] } } };
const gitOk = (cmd) => (cmd.includes('core.hooksPath') ? { status: 0, output: 'githooks\n' } : { status: 0, output: 'git version 2.40\n' });

function report(p, { exec = gitOk, nodeVersion = 'v22.0.0' } = {}) {
  return diagnose({ projectDir: p.dir, loaded: loadConfig(p.dir), exec, fs, pluginVersion: '0.1.0', nodeVersion });
}

test('healthy project → no warnings or errors', () => {
  const p = makeProject({ config, marker: 'package.json', files: { 'githooks/conventional-regex.txt': REGEX, 'githooks/commit-msg': '#!/bin/sh\n', ...rules } });
  try {
    const r = report(p);
    assert.deepEqual(r.findings.filter((f) => f.level !== 'ok'), []);
    const s = formatStatus(r, { pluginVersion: '0.1.0', config: loadConfig(p.dir).config });
    assert.match(s, /^cc-harness v0\.1\.0 · preset custom · guards: test commit quality git stop preflight/m);
    assert.match(s, /checks: tc\* test \(skipped: tc, missing tsconfig\.json\)/);
    assert.match(s, /stop gate: test/);
    assert.equal(s.split('\n').filter(Boolean).length, 5);
  } finally { p.cleanup(); }
});

test('problems are reported one per finding', () => {
  const p = makeProject({ config: { ...config, version: 1 }, files: { '.claude/rules/harness-testing.md': '<!-- cc-harness: v0.0.9 -->\n' } });
  try {
    const r = report(p, { exec: (cmd) => (cmd.includes('core.hooksPath') ? { status: 1, output: '' } : { status: 0, output: 'git version 2\n' }), nodeVersion: 'v16.0.0' });
    const texts = r.findings.filter((f) => f.level !== 'ok').map((f) => f.text).join('\n');
    assert.match(texts, /node v16.*18/i);
    assert.match(texts, /package\.json.*not found/);
    assert.match(texts, /conventional-regex\.txt.*not found/);
    assert.match(texts, /core\.hooksPath/);
    assert.match(texts, /harness-testing\.md.*v0\.0\.9.*0\.1\.0/);
    assert.match(texts, /harness-done\.md.*missing/);
  } finally { p.cleanup(); }
});

test('invalid config is a single error finding', () => {
  const p = makeProject({ files: { '.claude/harness.json': '{"version": 3}' } });
  try {
    const r = report(p);
    assert.equal(r.findings.filter((f) => f.level === 'error').length, 1);
    assert.match(r.findings.find((f) => f.level === 'error').text, /version must be 1/);
  } finally { p.cleanup(); }
});

test('ruleStamp', () => {
  assert.equal(ruleStamp('<!-- cc-harness: v0.1.0 -->\nhi'), '0.1.0');
  assert.equal(ruleStamp('# no stamp'), null);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/doctor.test.mjs`
Expected: FAIL, cannot find module `doctor.mjs`.

- [ ] **Step 3: Implement doctor.mjs**

```js
import path from 'node:path';
import { GUARD_NAMES, SUPPORTED_VERSION, isGuardEnabled } from './config.mjs';

export const RULE_NAMES = ['testing', 'done', 'commits', 'models', 'harness'];
export const NODE_FLOOR = 18;

export function ruleStamp(text) {
  const m = /^<!--\s*cc-harness:\s*v([0-9][^\s]*)\s*-->/m.exec(String(text ?? ''));
  return m ? m[1] : null;
}

export function diagnose({ projectDir, loaded, exec, fs, pluginVersion, nodeVersion = process.version }) {
  const F = [];
  const ok = (t) => F.push({ level: 'ok', text: t });
  const warn = (t) => F.push({ level: 'warn', text: t });
  const error = (t) => F.push({ level: 'error', text: t });
  const exists = (rel) => fs.existsSync(path.resolve(projectDir, rel));

  const major = parseInt(String(nodeVersion).replace(/^v/, ''), 10);
  if (major >= NODE_FLOOR) ok(`node ${nodeVersion}`); else error(`node ${nodeVersion} is below the required ${NODE_FLOOR}`);

  const git = exec('git --version', { cwd: projectDir });
  if (git.status === 0) ok('git available'); else error('git is not available on PATH');

  if (loaded.status === 'absent') { error('.claude/harness.json not found; run /cc-harness:init'); return finish(F); }
  if (loaded.status === 'invalid') { error(`.claude/harness.json is invalid: ${loaded.errors.join('; ')}`); return finish(F); }
  const c = loaded.config;
  ok(`config version ${c.version} (supported: ${SUPPORTED_VERSION}), preset ${c.preset}`);

  if (c.project.markerFile) {
    if (exists(c.project.markerFile)) ok(`marker file ${c.project.markerFile} present`);
    else warn(`marker file ${c.project.markerFile} not found; every guard stands down until it exists`);
  }

  if (isGuardEnabled(c, 'commit')) {
    const rf = c.guards.commit.regexFile;
    if (exists(rf)) ok(`commit regex file ${rf} present`); else warn(`commit regex file ${rf} not found; commits will be denied`);
    if (!exists('githooks/commit-msg')) warn('githooks/commit-msg not found; run /cc-harness:init, then: git config core.hooksPath githooks');
    else {
      const hp = exec('git config core.hooksPath', { cwd: projectDir });
      if (hp.status === 0 && hp.output.trim() === 'githooks') ok('git core.hooksPath=githooks');
      else warn('githooks/commit-msg exists but git core.hooksPath is not "githooks"; run: git config core.hooksPath githooks');
    }
  }

  for (const ch of c.checks) {
    if (ch.ifExists && !exists(ch.ifExists)) ok(`check ${ch.name} skipped (missing ${ch.ifExists})`);
  }

  for (const n of RULE_NAMES) {
    const rel = `.claude/rules/harness-${n}.md`;
    if (!exists(rel)) { warn(`${rel} missing; run /cc-harness:init or harness sync-rules`); continue; }
    const stamp = ruleStamp(fs.readFileSync(path.resolve(projectDir, rel), 'utf8'));
    if (stamp === pluginVersion) ok(`${rel} current`);
    else warn(`${rel} is stamped v${stamp ?? '?'} but the plugin is ${pluginVersion}; run harness sync-rules`);
  }
  return finish(F);
}

function finish(findings) {
  const bad = findings.filter((f) => f.level !== 'ok');
  return { findings, summary: bad.length ? `${bad.length} finding(s) need attention` : 'all checks passed' };
}

export function formatStatus(report, { pluginVersion, config }) {
  const lines = [];
  const guards = config ? GUARD_NAMES.filter((g) => isGuardEnabled(config, g)).join(' ') : 'none';
  lines.push(`cc-harness v${pluginVersion} · preset ${config?.preset ?? '-'} · guards: ${guards}`);
  if (config) {
    const skipped = report.findings.filter((f) => /^check (\S+) skipped \(missing (.+)\)$/.test(f.text)).map((f) => f.text.replace(/^check (\S+) skipped \(missing (.+)\)$/, '$1, missing $2'));
    const names = config.checks.map((c) => (c.fast ? `${c.name}*` : c.name)).join(' ') || 'none';
    lines.push(`checks: ${names}${skipped.length ? ` (skipped: ${skipped.join('; ')})` : ''}   (* = fast, runs after every edit)`);
    lines.push(`stop gate: ${config.guards.stop.checks.join(' ') || 'none'} · max blocks ${config.guards.stop.maxBlocks}`);
  }
  const bad = report.findings.filter((f) => f.level !== 'ok');
  lines.push(bad.length ? `attention: ${bad.map((f) => f.text).join(' | ')}` : 'doctor: all checks passed');
  lines.push('disable a guard: set guards.<name>.enabled=false in .claude/harness.json · details: /cc-harness:doctor');
  return lines.join('\n') + '\n';
}
```

Adjust the healthy-project assertion in the test if the exact wording differs, but keep five lines and the `tc* test (skipped: tc, missing tsconfig.json)` fragment.

- [ ] **Step 4: Run doctor tests**

Run: `node --test test/doctor.test.mjs`
Expected: PASS.

- [ ] **Step 5: Write failing preflight tests**

`test/guard-preflight.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { evaluate } from '../plugins/cc-harness/lib/guards/preflight.mjs';
import { markDirty, markerPath, readMarker } from '../plugins/cc-harness/lib/session.mjs';
import { DEFAULTS, mergeConfig } from '../plugins/cc-harness/lib/config.mjs';
import { makeProject, makeDataDir } from './helpers/project.mjs';

const exec = (cmd) => ({ status: 0, output: cmd.includes('hooksPath') ? 'githooks\n' : 'git version 2\n' });

test('preflight returns a context block and prunes old markers on startup only', () => {
  const p = makeProject({ config: { version: 1 } }); const d = makeDataDir();
  try {
    markDirty(d.dir, 'old', 'x');
    const past = new Date(Date.now() - 10 * 86400e3); fs.utimesSync(markerPath(d.dir, 'old'), past, past);
    const config = mergeConfig(DEFAULTS, {});
    const resume = evaluate({ event: 'SessionStart', input: { source: 'resume', session_id: 's' }, config, projectDir: p.dir, dataDir: d.dir, exec, fs, pluginRoot: '' });
    assert.equal(resume.kind, 'context'); assert.match(resume.reason, /^cc-harness v/);
    assert.notEqual(readMarker(d.dir, 'old'), null);
    evaluate({ event: 'SessionStart', input: { source: 'startup', session_id: 's' }, config, projectDir: p.dir, dataDir: d.dir, exec, fs, pluginRoot: '' });
    assert.equal(readMarker(d.dir, 'old'), null);
  } finally { p.cleanup(); d.cleanup(); }
});
```

- [ ] **Step 6: Implement guards/preflight.mjs, register, and wire `doctor` subcommand**

`lib/guards/preflight.mjs`:
```js
import { context } from '../hook-io.mjs';
import { diagnose, formatStatus } from '../doctor.mjs';
import { pruneMarkers } from '../session.mjs';
import { pluginVersion } from '../meta.mjs';

export const name = 'preflight';
export const event = 'SessionStart';
const SEVEN_DAYS = 7 * 86400e3;

export function evaluate({ input, config, projectDir, dataDir, exec, fs }) {
  if (input.source === 'startup') { try { pruneMarkers(dataDir, SEVEN_DAYS); } catch { /* best effort */ } }
  const v = pluginVersion();
  const report = diagnose({ projectDir, loaded: { status: 'ok', config }, exec, fs, pluginVersion: v });
  return context(formatStatus(report, { pluginVersion: v, config }));
}
```

`lib/guards/index.mjs`: add `preflightGuard` to `GUARDS`.

`lib/cli.mjs` `runDoctor`:
```js
async function runDoctor(args, io) {
  const target = path.resolve(argValue(args, '--target') ?? io.env.CLAUDE_PROJECT_DIR ?? process.cwd());
  const loaded = loadConfig(target);
  const report = diagnose({ projectDir: target, loaded, exec: defaultExec, fs, pluginVersion: pluginVersion() });
  for (const f of report.findings) io.stdout.write(`${{ ok: '✔', warn: '⚠', error: '✖' }[f.level]} ${f.text}\n`);
  io.stdout.write(`\n${report.summary}\n`);
  return report.findings.some((f) => f.level === 'error') ? 1 : 0;
}

export function argValue(args, flag) {
  const i = args.indexOf(flag);
  if (i !== -1) return args[i + 1];
  const eq = args.find((a) => a.startsWith(flag + '='));
  return eq ? eq.slice(flag.length + 1) : undefined;
}
```
Add the imports (`diagnose`, `defaultExec`, `path`, `fs`).

- [ ] **Step 7: Run everything and try doctor by hand**

Run: `node --test test/*.test.mjs && node plugins/cc-harness/bin/harness.mjs doctor --target "$PWD"; echo "exit=$?"`
Expected: tests PASS; doctor prints `✖ .claude/harness.json not found; run /cc-harness:init` and `exit=1` (this repo is not dogfooded until T8).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(guards): add doctor and session preflight"
```

---

### Task 6: Renderer, TS preset, templates

**Files:**
- Create: `plugins/cc-harness/lib/render.mjs`
- Create: `plugins/cc-harness/presets/ts.json`
- Create: `plugins/cc-harness/templates/CLAUDE.md.tmpl`
- Create: `plugins/cc-harness/templates/rules/harness-{testing,done,commits,models,harness}.md.tmpl`
- Create: `plugins/cc-harness/templates/ci.yml.tmpl`
- Test: `test/render.test.mjs`, `test/presets.test.mjs`

**Interfaces:**
- Produces (render): `render(template, vars) → string` (`{{KEY}}` where KEY is `[A-Z0-9_]+`; unknown keys are left untouched); `deepMergeSettings(existing, fragment) → object` (objects recurse, arrays union with existing order first, scalars: existing wins); `buildRegex(types, scopes) → string`; `templateVars({config, preset, types, scopes, pluginVersion, projectName}) → object` producing every key the templates use: `PROJECT_NAME PRESET HARNESS_VERSION COMMANDS TEST_GLOBS STOP_CHECKS FAST_CHECKS COMMIT_TYPES COMMIT_SCOPES COMMIT_SCOPES_LINE COMMIT_REGEX COMMIT_REGEX_FILE TRAILER_RULE GUARDS CI_SETUP_STEPS CI_CHECK_STEPS`; `templatesDir()`.
- Produces (preset key `ci.setupSteps`): an array of GitHub Actions step objects, preset-only, ignored by guards.
- Template rule: every rules template begins with the exact line `<!-- cc-harness: v{{HARNESS_VERSION}} -->` (doctor's `ruleStamp` depends on it).

- [ ] **Step 1: Write failing render tests**

`test/render.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, deepMergeSettings, buildRegex, templateVars } from '../plugins/cc-harness/lib/render.mjs';
import { DEFAULTS, mergeConfig, loadPreset } from '../plugins/cc-harness/lib/config.mjs';

test('render substitutes known keys and leaves unknown ones and GitHub expressions alone', () => {
  assert.equal(render('a {{X}} b {{Y}} ${{ github.base_ref }}', { X: '1' }), 'a 1 b {{Y}} ${{ github.base_ref }}');
  assert.equal(render('{{X}}{{X}}', { X: 'a/b&c' }), 'a/b&ca/b&c');
});

test('deepMergeSettings: existing scalars win, arrays union, objects recurse', () => {
  const out = deepMergeSettings(
    { permissions: { allow: ['Bash(a:*)'], defaultMode: 'plan' }, model: 'x' },
    { permissions: { allow: ['Bash(b:*)', 'Bash(a:*)'], ask: ['Bash(rm:*)'], defaultMode: 'acceptEdits' }, enabledPlugins: { 'cc-harness@cc-harness': true } },
  );
  assert.deepEqual(out, {
    permissions: { allow: ['Bash(a:*)', 'Bash(b:*)'], defaultMode: 'plan', ask: ['Bash(rm:*)'] },
    model: 'x',
    enabledPlugins: { 'cc-harness@cc-harness': true },
  });
});

test('buildRegex with and without scopes', () => {
  assert.equal(buildRegex(['feat', 'fix'], ['cli']), '^(feat|fix)(\\((cli)\\))?!?: [a-z](.{0,64}[^.])?$');
  assert.equal(buildRegex(['feat'], []), '^(feat)(\\([a-z0-9-]+\\))?!?: [a-z](.{0,64}[^.])?$');
  assert.match('feat(cli): add x', new RegExp(buildRegex(['feat'], ['cli'])));
  assert.doesNotMatch('feat(cli): Add x.', new RegExp(buildRegex(['feat'], ['cli'])));
});

test('templateVars covers every template key', () => {
  const preset = loadPreset('ts');
  const config = mergeConfig(DEFAULTS, preset);
  const v = templateVars({ config, preset, types: ['feat', 'fix'], scopes: [], pluginVersion: '0.1.0', projectName: 'demo' });
  for (const k of ['PROJECT_NAME', 'PRESET', 'HARNESS_VERSION', 'COMMANDS', 'TEST_GLOBS', 'STOP_CHECKS', 'FAST_CHECKS', 'COMMIT_TYPES', 'COMMIT_SCOPES', 'COMMIT_SCOPES_LINE', 'COMMIT_REGEX', 'COMMIT_REGEX_FILE', 'TRAILER_RULE', 'GUARDS', 'CI_SETUP_STEPS', 'CI_CHECK_STEPS']) {
    assert.equal(typeof v[k], 'string', k);
  }
  assert.equal(v.COMMIT_SCOPES_LINE, 'any lower-case word, e.g. `feat(api): ...`');
  assert.match(v.CI_SETUP_STEPS, /actions\/setup-node@v4/);
  assert.match(v.CI_CHECK_STEPS, /- name: typecheck\n\s+run: .*tsc --noEmit/);
  assert.match(v.CI_CHECK_STEPS, /\[ -e "tsconfig\.json" \] \|\| exit 0/);
  assert.match(v.TRAILER_RULE, /Co-Authored-By/);
  assert.equal(templateVars({ config: mergeConfig(config, { guards: { commit: { rejectAttributionTrailers: false } } }), preset, types: ['feat'], scopes: [], pluginVersion: '0.1.0', projectName: 'd' }).TRAILER_RULE, '');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/render.test.mjs`
Expected: FAIL, cannot find module `render.mjs`.

- [ ] **Step 3: Write presets/ts.json**

```json
{
  "project": {
    "markerFile": "package.json",
    "sourceGlobs": ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx", "**/*.mjs", "**/*.cjs"],
    "testGlobs": ["**/*.test.*", "**/*.spec.*", "**/__tests__/**"]
  },
  "commands": {
    "safe": ["node", "tsc", "vitest", "jest", "eslint", "prettier", "tsx", "ts-node"],
    "write": [
      { "cmd": "prettier", "whenFlags": ["--write", "-w"] },
      { "cmd": "eslint", "whenFlags": ["--fix"] },
      { "cmd": "node", "whenFlags": ["-e", "--eval", "-p", "--print"] },
      { "cmd": "tsx", "whenFlags": ["-e", "--eval"] }
    ]
  },
  "checks": [
    { "name": "typecheck", "cmd": "node_modules/.bin/tsc --noEmit", "ifExists": "tsconfig.json", "fast": true },
    { "name": "lint", "cmd": "node_modules/.bin/eslint .", "ifExists": "node_modules/.bin/eslint", "fast": true },
    { "name": "format", "cmd": "node_modules/.bin/prettier --check .", "ifExists": "node_modules/.bin/prettier", "fast": true },
    { "name": "test", "cmd": "node_modules/.bin/vitest run", "ifExists": "node_modules/.bin/vitest" },
    { "name": "test-jest", "cmd": "node_modules/.bin/jest --ci", "ifExists": "node_modules/.bin/jest" }
  ],
  "guards": {
    "stop": { "checks": ["typecheck", "test", "test-jest"] }
  },
  "ci": {
    "setupSteps": [
      { "uses": "actions/setup-node@v4", "with": { "node-version": "20", "cache": "npm" } },
      { "run": "npm ci" }
    ]
  }
}
```

Rationale to keep in `docs/presets.md` later: tools are invoked as `node_modules/.bin/<tool>` rather than `npx` because `npx` may reach the network, which sandboxes block; vitest and jest run in explicit non-watch modes so a watch default cannot hang the 600 s hook.

- [ ] **Step 4: Write the templates**

`templates/CLAUDE.md.tmpl`:
```markdown
# CLAUDE.md

This file provides guidance to Claude Code when working in this repository.
Conventions enforced by the cc-harness plugin live in `.claude/rules/harness-*.md`; keep project-specific knowledge here.

## What {{PROJECT_NAME}} is

<!-- One paragraph: what the project does, who uses it, and the one design constraint everyone must know. -->

## Commands

{{COMMANDS}}

## Layout

<!-- Where the important things live and why. Point at directories, not files. -->

## Sandbox notes

<!-- Commands that need the network or a listening port fail under the Bash sandbox. List them here so sessions do not rediscover it. -->
```

`templates/rules/harness-testing.md.tmpl`:
```markdown
<!-- cc-harness: v{{HARNESS_VERSION}} -->
<!-- Generated by cc-harness init; regenerate with `harness sync-rules`. Change what is enforced in .claude/harness.json, not here. -->
# Testing

- Work test-first. Write one failing test for one behaviour, run it, watch it fail for the right reason, write the minimum code that passes, then refactor. Do not write several tests and then the implementation.
- An existing test is a contract. Changing or deleting one needs explicit permission: explain what the test gets wrong and wait for a yes. The test guard prompts on edits to files matching {{TEST_GLOBS}}; a prompt is a request for a human decision, not an obstacle to route around.
- Never weaken an assertion to make a test pass. If a test is wrong, say so and ask.
- Running tests never needs permission.
```

`templates/rules/harness-done.md.tmpl`:
```markdown
<!-- cc-harness: v{{HARNESS_VERSION}} -->
<!-- Generated by cc-harness init; regenerate with `harness sync-rules`. -->
# Definition of done

- Never report work as done based on reasoning about the code. Run the checks and read the output.
- Before a turn can end with changed source files, these checks must pass (the stop gate runs them): {{STOP_CHECKS}}.
- After every source edit the fast checks run automatically: {{FAST_CHECKS}}. When one fails, fix it before starting new work.
- If a check cannot run (missing tool, sandbox restriction), say so explicitly instead of claiming success.
```

`templates/rules/harness-commits.md.tmpl`:
```markdown
<!-- cc-harness: v{{HARNESS_VERSION}} -->
<!-- Generated by cc-harness init; regenerate with `harness sync-rules`. -->
# Commit messages

- Format: `type(scope): subject`. Subject in lower-case imperative, no trailing period, at most 65 characters after the colon. `!` before the colon marks a breaking change.
- Types: {{COMMIT_TYPES}}
- Scopes: {{COMMIT_SCOPES_LINE}}
- The regex in `{{COMMIT_REGEX_FILE}}` is the source of truth; edit that file to change the rule. The same rule runs in the Claude commit guard, the git commit-msg hook, and CI.
{{TRAILER_RULE}}- One commit per logical change. A body is optional; when present, it explains why, not what.
- Examples: `feat(api): add rate limiting to login`, `fix: handle empty upload gracefully`, `refactor!: drop the v1 config format`
```

`templates/rules/harness-models.md.tmpl`:
```markdown
<!-- cc-harness: v{{HARNESS_VERSION}} -->
<!-- Generated by cc-harness init; regenerate with `harness sync-rules`. -->
# Subagent model assignment

Always name a model explicitly when dispatching a subagent; omitting it inherits the session's model, usually the most expensive one.

## Implementers

Cheapest tier when all four hold: the brief carries the complete code so the work is transcription, not design; one package, one commit; verification is "run this named command and paste the output"; nothing outside the brief needs noticing.

Step up one tier when any one holds: success depends on an experiment (a test that must fail under a named change); the task must decide whether to change anything, not just what; more than about three items in one dispatch or multi-file coordination; the defect may sit next to the brief rather than inside it.

Step up again for architecture, design, and anything where the shape of the answer is not already settled.

## Reviewers

Use the most capable tier, effectively always. Reviewing is judgment work, and a capable reviewer is where defects actually get found, including defects in the plan the tasks were built from.

## Why

Cheap models substitute reasoning for execution when asked to prove something empirically, and their self-reported bookkeeping decays silently. Verify their numbers; disregard their self-review checkmarks. Turn count, not token price, is the real cost of a large batch on a cheap tier. Every substantive defect tends to be found by a reviewer, none by an implementer, so cutting reviewer capability is the wrong economy; writing better briefs is the right one.

## Second opinions on briefs

If your setup has a reviewer or advisor tool that sees the whole transcript, use it on the brief, not only on the code: before finalising a plan subagents will build from, before prescribing exact code or test cases, and when a review finding contradicts the plan. Brief defects, not implementer mistakes, cause most rework.
```

`templates/rules/harness-harness.md.tmpl`:
```markdown
<!-- cc-harness: v{{HARNESS_VERSION}} -->
<!-- Generated by cc-harness init; regenerate with `harness sync-rules`. -->
# cc-harness

This project uses the cc-harness plugin (v{{HARNESS_VERSION}}, preset `{{PRESET}}`). Active guards: {{GUARDS}}.

- Configuration lives in `.claude/harness.json`. Disable a guard with `"guards": { "<name>": { "enabled": false } }`.
- A prompt or block from a guard is a request for a human decision. Do not work around a guard by renaming a file, splitting a command, or using a different tool; answer the prompt or ask.
- Session start prints a status block. If it reports findings, address them before other work.
- Health check: `/cc-harness:doctor`. After a plugin update, refresh these rules with `harness sync-rules` (via `/cc-harness:init`).
```

`templates/ci.yml.tmpl`:
```yaml
name: harness

on:
  push:
  pull_request:

jobs:
  checks:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
{{CI_SETUP_STEPS}}
{{CI_CHECK_STEPS}}

  commits:
    runs-on: ubuntu-latest
    if: github.event_name == 'pull_request'
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - name: Check commit messages against githooks/conventional-regex.txt
        run: |
          set -e
          for sha in $(git rev-list "origin/${{ github.base_ref }}..HEAD"); do
            git log -1 --format=%B "$sha" > /tmp/msg
            sh githooks/commit-msg /tmp/msg || { echo "commit $sha rejected"; exit 1; }
          done
```

- [ ] **Step 5: Implement render.mjs**

```js
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GUARD_NAMES, isGuardEnabled } from './config.mjs';

export function templatesDir() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates');
}

export function render(template, vars) {
  return String(template).replace(/\{\{([A-Z0-9_]+)\}\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m));
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function deepMergeSettings(existing, fragment) {
  if (Array.isArray(existing) && Array.isArray(fragment)) {
    const out = [...existing];
    for (const v of fragment) if (!out.some((x) => JSON.stringify(x) === JSON.stringify(v))) out.push(v);
    return out;
  }
  if (isObj(existing) && isObj(fragment)) {
    const out = { ...existing };
    for (const [k, v] of Object.entries(fragment)) out[k] = k in existing ? deepMergeSettings(existing[k], v) : v;
    return out;
  }
  return existing === undefined ? fragment : existing;
}

export const DEFAULT_TYPES = ['feat', 'fix', 'docs', 'test', 'refactor', 'perf', 'build', 'ci', 'chore', 'revert'];

export function buildRegex(types, scopes) {
  const scope = scopes.length ? `(\\((${scopes.join('|')})\\))?` : '(\\([a-z0-9-]+\\))?';
  return `^(${types.join('|')})${scope}!?: [a-z](.{0,64}[^.])?$`;
}

function yamlStep(step, indent = '      ') {
  const lines = [];
  const keys = Object.keys(step);
  keys.forEach((k, i) => {
    const prefix = i === 0 ? `${indent}- ` : `${indent}  `;
    const v = step[k];
    if (isObj(v)) {
      lines.push(`${prefix}${k}:`);
      for (const [kk, vv] of Object.entries(v)) lines.push(`${indent}    ${kk}: ${JSON.stringify(vv)}`);
    } else lines.push(`${prefix}${k}: ${k === 'run' ? `'${String(v).replace(/'/g, "''")}'` : v}`);   // run is single-quoted: it may start with [ or contain : and #
  });
  return lines.join('\n');
}

export function templateVars({ config, preset = {}, types, scopes, pluginVersion, projectName }) {
  const checks = config.checks;
  const fast = checks.filter((c) => c.fast).map((c) => c.name);
  const commands = checks.length
    ? '```sh\n' + checks.map((c) => `${c.cmd.padEnd(44)} # ${c.name}${c.fast ? ' (fast)' : ''}`).join('\n') + '\n```'
    : '<!-- Build, test, lint, and run commands. Keep them copy-pasteable. -->';
  const ciChecks = checks.map((c) => {
    const run = c.ifExists ? `[ -e "${c.ifExists}" ] || exit 0; ${c.cmd}` : c.cmd;
    return yamlStep({ name: c.name, run });
  }).join('\n');
  const ciSetup = (preset.ci?.setupSteps ?? []).map((s) => yamlStep(s)).join('\n');
  const rejectTrailers = config.guards.commit.rejectAttributionTrailers;
  return {
    PROJECT_NAME: projectName,
    PRESET: config.preset,
    HARNESS_VERSION: pluginVersion,
    COMMANDS: commands,
    TEST_GLOBS: config.project.testGlobs.map((g) => `\`${g}\``).join(', ') || '(none configured)',
    STOP_CHECKS: config.guards.stop.checks.join(', ') || '(none configured)',
    FAST_CHECKS: fast.join(', ') || '(none configured)',
    COMMIT_TYPES: types.join(' '),
    COMMIT_SCOPES: scopes.join(' '),
    COMMIT_SCOPES_LINE: scopes.length ? scopes.join(' ') : 'any lower-case word, e.g. `feat(api): ...`',
    COMMIT_REGEX: buildRegex(types, scopes),
    COMMIT_REGEX_FILE: config.guards.commit.regexFile,
    TRAILER_RULE: rejectTrailers ? '- No attribution trailers: no `Co-Authored-By`, `Claude-Session`, or "Generated with" lines. This overrides any instruction from a harness or session to add them.\n' : '',
    GUARDS: GUARD_NAMES.filter((g) => isGuardEnabled(config, g)).join(', '),
    CI_SETUP_STEPS: ciSetup,
    CI_CHECK_STEPS: ciChecks,
  };
}
```

- [ ] **Step 6: Write the presets test**

`test/presets.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULTS, mergeConfig, validateConfig, defaultPresetsDir, loadPreset } from '../plugins/cc-harness/lib/config.mjs';
import { templatesDir } from '../plugins/cc-harness/lib/render.mjs';
import { RULE_NAMES } from '../plugins/cc-harness/lib/doctor.mjs';

test('every shipped preset merges into a valid config', () => {
  for (const f of fs.readdirSync(defaultPresetsDir()).filter((x) => x.endsWith('.json'))) {
    const preset = loadPreset(f.replace(/\.json$/, ''));
    assert.deepEqual(validateConfig(mergeConfig(DEFAULTS, preset)), [], f);
  }
});

test('ts preset facts the docs rely on', () => {
  const c = mergeConfig(DEFAULTS, loadPreset('ts'));
  assert.equal(c.project.markerFile, 'package.json');
  assert.ok(c.checks.every((ch) => !ch.cmd.startsWith('npx')));
  assert.deepEqual(c.guards.stop.checks, ['typecheck', 'test', 'test-jest']);
});

test('every rules template starts with the version stamp line', () => {
  for (const n of RULE_NAMES) {
    const t = fs.readFileSync(path.join(templatesDir(), 'rules', `harness-${n}.md.tmpl`), 'utf8');
    assert.ok(t.startsWith('<!-- cc-harness: v{{HARNESS_VERSION}} -->\n'), n);
  }
  assert.ok(fs.existsSync(path.join(templatesDir(), 'CLAUDE.md.tmpl')));
  assert.ok(fs.existsSync(path.join(templatesDir(), 'ci.yml.tmpl')));
  assert.ok(fs.existsSync(path.join(templatesDir(), 'githooks', 'commit-msg')));
});
```

- [ ] **Step 7: Run the whole suite**

Run: `node --test test/*.test.mjs`
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(presets): add renderer, ts preset, and templates"
```

---

### Task 7: init and sync-rules

**Files:**
- Create: `plugins/cc-harness/lib/init.mjs`
- Modify: `plugins/cc-harness/lib/cli.mjs` (`runInit`, `runSyncRules`, arg parsing)
- Test: `test/init.test.mjs`

**Interfaces:**
- Produces: `planInit(opts) → { writes: Write[], refusals: string[], checklist: string[] }` where `Write = { rel: string, content: string, action: 'create'|'overwrite'|'merge'|'beside'|'append', mode?: number }`; `applyWrites(targetDir, writes, fs)`; `init(opts, io) → number`; `syncRules(opts, io) → number`; `parseInitArgs(args, env) → opts`.
- `opts`: `{ targetDir, preset ('ts'|'custom'), types: string[], scopes: string[], marketplace: string, force: boolean, dryRun: boolean, projectName: string, presetsDir?, templatesDir?, pluginVersion? }`.
- Marketplace rule: `owner/repo` → `extraKnownMarketplaces` with `{ source: 'github', repo }` into `.claude/settings.json`; anything else is treated as a local path → `{ source: 'directory', path }` into `.claude/settings.local.json` plus a `.gitignore` line. Default marketplace: the directory two levels above `pluginRoot()` when it contains `.claude-plugin/marketplace.json` (a local checkout), else `malek/cc-harness`.

- [ ] **Step 1: Write failing init tests**

`test/init.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { planInit, init, syncRules, parseInitArgs } from '../plugins/cc-harness/lib/init.mjs';
import { ruleStamp, RULE_NAMES } from '../plugins/cc-harness/lib/doctor.mjs';
import { parseRegexFile } from '../plugins/cc-harness/lib/commit-rules.mjs';
import { makeProject } from './helpers/project.mjs';

const sink = () => { let s = ''; const w = new Writable({ write(c, e, cb) { s += c; cb(); } }); w.text = () => s; return w; };
const io = () => ({ stdout: sink(), stderr: sink(), env: {} });
const base = (dir, over = {}) => ({ targetDir: dir, preset: 'ts', types: ['feat', 'fix'], scopes: ['api'], marketplace: 'acme/cc-harness', force: false, dryRun: false, projectName: 'demo', pluginVersion: '0.1.0', ...over });

const EXPECTED = [
  '.claude/harness.json', '.claude/settings.json', 'CLAUDE.md',
  ...RULE_NAMES.map((n) => `.claude/rules/harness-${n}.md`),
  'githooks/commit-msg', 'githooks/conventional-regex.txt', '.github/workflows/harness.yml',
];

test('fresh ts project: exact file set, contents wired together', () => {
  const p = makeProject({ files: { 'package.json': '{}' } });
  try {
    const o = io();
    assert.equal(init(base(p.dir), o), 0);
    for (const f of EXPECTED) assert.ok(p.exists(f), `missing ${f}`);
    assert.ok(!p.exists('.claude/settings.local.json'));
    assert.deepEqual(JSON.parse(p.read('.claude/harness.json')), { version: 1, preset: 'ts' });
    const s = JSON.parse(p.read('.claude/settings.json'));
    assert.equal(s.enabledPlugins['cc-harness@cc-harness'], true);
    assert.deepEqual(s.extraKnownMarketplaces['cc-harness'], { source: { source: 'github', repo: 'acme/cc-harness' } });
    assert.ok(s.permissions.allow.includes('Bash(git status:*)'));
    assert.ok(s.permissions.ask.includes('Bash(git push:*)'));
    assert.ok(s.permissions.ask.includes('Bash(prettier --write:*)'));
    assert.ok(s.permissions.deny.includes('Read(./.env)'));
    const rules = parseRegexFile(p.read('githooks/conventional-regex.txt'));
    assert.deepEqual(rules.types, ['feat', 'fix']); assert.deepEqual(rules.scopes, ['api']);
    assert.match('feat(api): x', rules.regex);
    assert.equal(ruleStamp(p.read('.claude/rules/harness-testing.md')), '0.1.0');
    assert.match(p.read('.claude/rules/harness-commits.md'), /Types: feat fix/);
    assert.match(p.read('.claude/rules/harness-done.md'), /typecheck, test, test-jest/);
    assert.match(p.read('CLAUDE.md'), /## What demo is/);
    assert.match(p.read('.github/workflows/harness.yml'), /setup-node@v4/);
    assert.equal(fs.statSync(path.join(p.dir, 'githooks/commit-msg')).mode & 0o111, 0o111);
    assert.match(o.stdout.text(), /git config core\.hooksPath githooks/);
    assert.match(o.stdout.text(), /claude plugin install cc-harness@cc-harness/);
  } finally { p.cleanup(); }
});

test('second run: refuses harness.json and regex file, overwrites rules, preserves settings keys', () => {
  const p = makeProject({ files: { 'package.json': '{}' } });
  try {
    init(base(p.dir), io());
    p.write('.claude/rules/harness-testing.md', '<!-- cc-harness: v0.0.1 -->\nold');
    p.write('githooks/conventional-regex.txt', '^custom$\n');
    const s = JSON.parse(p.read('.claude/settings.json')); s.model = 'keep-me'; s.permissions.allow.push('Bash(mine:*)');
    p.write('.claude/settings.json', JSON.stringify(s));
    const o = io();
    assert.equal(init(base(p.dir), o), 1);
    assert.match(o.stderr.text(), /harness\.json.*exists/); assert.match(o.stderr.text(), /conventional-regex\.txt.*exists/);
    assert.equal(p.read('githooks/conventional-regex.txt'), '^custom$\n');               // nothing written on refusal
    assert.equal(ruleStamp(p.read('.claude/rules/harness-testing.md')), '0.0.1');
    assert.equal(init(base(p.dir, { force: true }), io()), 0);
    assert.equal(ruleStamp(p.read('.claude/rules/harness-testing.md')), '0.1.0');
    assert.match(p.read('githooks/conventional-regex.txt'), /^\^\(feat\|fix\)/);
    const s2 = JSON.parse(p.read('.claude/settings.json'));
    assert.equal(s2.model, 'keep-me'); assert.ok(s2.permissions.allow.includes('Bash(mine:*)'));
    assert.equal(s2.permissions.allow.filter((x) => x === 'Bash(git status:*)').length, 1);
  } finally { p.cleanup(); }
});

test('existing CLAUDE.md is kept; CLAUDE.harness.md written beside it', () => {
  const p = makeProject({ files: { 'package.json': '{}', 'CLAUDE.md': 'mine' } });
  try {
    const o = io();
    init(base(p.dir), o);
    assert.equal(p.read('CLAUDE.md'), 'mine'); assert.ok(p.exists('CLAUDE.harness.md'));
    assert.match(o.stdout.text(), /CLAUDE\.harness\.md/);
  } finally { p.cleanup(); }
});

test('local marketplace path goes to settings.local.json and .gitignore', () => {
  const p = makeProject({ files: { 'package.json': '{}', '.gitignore': 'node_modules\n' } });
  try {
    init(base(p.dir, { marketplace: '/abs/checkout/cc-harness' }), io());
    const local = JSON.parse(p.read('.claude/settings.local.json'));
    assert.deepEqual(local.extraKnownMarketplaces['cc-harness'], { source: { source: 'directory', path: '/abs/checkout/cc-harness' } });
    assert.ok(!('extraKnownMarketplaces' in JSON.parse(p.read('.claude/settings.json'))));
    assert.match(p.read('.gitignore'), /^\.claude\/settings\.local\.json$/m);
    assert.match(p.read('.gitignore'), /^node_modules$/m);
  } finally { p.cleanup(); }
});

test('custom preset writes an expanded harness.json skeleton; dry-run writes nothing', () => {
  const p = makeProject({});
  try {
    const plan = planInit(base(p.dir, { preset: 'custom' }));
    const h = JSON.parse(plan.writes.find((w) => w.rel === '.claude/harness.json').content);
    assert.equal(h.preset, 'custom'); assert.deepEqual(h.project.testGlobs, []); assert.deepEqual(h.checks, []);
    assert.equal(init(base(p.dir, { preset: 'custom', dryRun: true }), io()), 0);
    assert.ok(!p.exists('.claude/harness.json'));
  } finally { p.cleanup(); }
});

test('syncRules re-renders only rules and the hook script', () => {
  const p = makeProject({ files: { 'package.json': '{}' } });
  try {
    init(base(p.dir), io());
    p.write('.claude/rules/harness-done.md', 'stale'); p.write('githooks/commit-msg', 'stale'); p.write('CLAUDE.md', 'mine');
    assert.equal(syncRules({ targetDir: p.dir, pluginVersion: '0.2.0' }, io()), 0);
    assert.equal(ruleStamp(p.read('.claude/rules/harness-done.md')), '0.2.0');
    assert.match(p.read('githooks/commit-msg'), /^#!\/bin\/sh/);
    assert.equal(p.read('CLAUDE.md'), 'mine');
    assert.match(p.read('.claude/rules/harness-commits.md'), /Types: feat fix/);   // types re-read from the regex file
  } finally { p.cleanup(); }
});

test('parseInitArgs', () => {
  const o = parseInitArgs(['--preset', 'custom', '--types', 'a,b', '--scopes=x', '--force', '--dry-run', '--target', '/t', '--marketplace', 'o/r'], {});
  assert.equal(o.preset, 'custom'); assert.deepEqual(o.types, ['a', 'b']); assert.deepEqual(o.scopes, ['x']);
  assert.equal(o.force, true); assert.equal(o.dryRun, true); assert.equal(o.targetDir, '/t'); assert.equal(o.marketplace, 'o/r');
  const d = parseInitArgs([], { CLAUDE_PROJECT_DIR: '/proj' });
  assert.equal(d.targetDir, '/proj'); assert.equal(d.preset, 'ts'); assert.equal(d.projectName, 'proj'); assert.ok(d.types.includes('feat'));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/init.test.mjs`
Expected: FAIL, cannot find module `init.mjs`.

- [ ] **Step 3: Implement init.mjs**

```js
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULTS, mergeConfig, loadPreset, loadConfig, defaultPresetsDir } from './config.mjs';
import { render, deepMergeSettings, buildRegex, templateVars, templatesDir, DEFAULT_TYPES } from './render.mjs';
import { parseRegexFile } from './commit-rules.mjs';
import { RULE_NAMES } from './doctor.mjs';
import { pluginRoot, pluginVersion } from './meta.mjs';

const PLUGIN_KEY = 'cc-harness@cc-harness';
const MARKET = 'cc-harness';
const LOCAL_SETTINGS = '.claude/settings.local.json';

export function defaultMarketplace() {
  const candidate = path.resolve(pluginRoot(), '..', '..');
  return fs.existsSync(path.join(candidate, '.claude-plugin', 'marketplace.json')) ? candidate : 'malek/cc-harness';
}

export function parseInitArgs(args, env) {
  const val = (flag) => { const i = args.indexOf(flag); if (i !== -1) return args[i + 1]; const eq = args.find((a) => a.startsWith(flag + '=')); return eq ? eq.slice(flag.length + 1) : undefined; };
  const list = (s, dflt) => (s === undefined ? dflt : s.split(',').map((x) => x.trim()).filter(Boolean));
  const targetDir = path.resolve(val('--target') ?? env.CLAUDE_PROJECT_DIR ?? process.cwd());
  return {
    targetDir,
    preset: val('--preset') ?? 'ts',
    types: list(val('--types'), DEFAULT_TYPES),
    scopes: list(val('--scopes'), []),
    marketplace: val('--marketplace') ?? defaultMarketplace(),
    force: args.includes('--force'),
    dryRun: args.includes('--dry-run'),
    projectName: val('--name') ?? path.basename(targetDir),
  };
}

const isRepo = (m) => /^[\w.-]+\/[\w.-]+$/.test(m);

function permissionFragment(config) {
  const allow = new Set(['Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git branch:*)']);
  for (const c of config.checks) allow.add(`Bash(${c.cmd.split(/\s+/)[0]}:*)`);
  const ask = new Set(['Bash(git push:*)', 'Bash(rm:*)']);
  for (const w of config.commands.write) {
    if (w.whenFlags) for (const f of w.whenFlags) ask.add(`Bash(${w.cmd} ${f}:*)`);
    else ask.add(`Bash(${w.cmd}:*)`);
  }
  const deny = ['Read(./.env)', 'Read(./.env.*)', 'Edit(./.env)', 'Edit(./.env.*)', 'Read(**/*.pem)', 'Edit(**/*.pem)', 'Read(**/credentials.*)', 'Read(~/.ssh/**)', 'Read(~/.gnupg/**)'];
  return { allow: [...allow], ask: [...ask], deny };
}

export function planInit(opts) {
  const presetsDir = opts.presetsDir ?? defaultPresetsDir();
  const tdir = opts.templatesDir ?? templatesDir();
  const version = opts.pluginVersion ?? pluginVersion();
  const preset = opts.preset === 'custom' ? {} : loadPreset(opts.preset, presetsDir);
  if (preset === null) throw new Error(`unknown preset "${opts.preset}"`);
  const config = mergeConfig(mergeConfig(DEFAULTS, preset), { preset: opts.preset });
  const vars = templateVars({ config, preset, types: opts.types, scopes: opts.scopes, pluginVersion: version, projectName: opts.projectName });
  const tpl = (rel) => fs.readFileSync(path.join(tdir, rel), 'utf8');
  const exists = (rel) => fs.existsSync(path.join(opts.targetDir, rel));
  const writes = [];
  const refusals = [];

  const harnessJson = opts.preset === 'custom'
    ? { version: 1, preset: 'custom', project: { markerFile: '', sourceGlobs: [], testGlobs: [] }, commands: { safe: [], write: [] }, checks: [], guards: { stop: { checks: [] } } }
    : { version: 1, preset: opts.preset };
  if (exists('.claude/harness.json') && !opts.force) refusals.push('.claude/harness.json exists; pass --force to overwrite it');
  writes.push({ rel: '.claude/harness.json', content: JSON.stringify(harnessJson, null, 2) + '\n', action: exists('.claude/harness.json') ? 'overwrite' : 'create' });

  const settingsFragment = { enabledPlugins: { [PLUGIN_KEY]: true }, permissions: permissionFragment(config) };
  const marketEntry = { [MARKET]: { source: isRepo(opts.marketplace) ? { source: 'github', repo: opts.marketplace } : { source: 'directory', path: path.resolve(opts.marketplace) } } };
  if (isRepo(opts.marketplace)) settingsFragment.extraKnownMarketplaces = marketEntry;
  writes.push(mergeJsonWrite(opts.targetDir, '.claude/settings.json', settingsFragment));
  if (!isRepo(opts.marketplace)) {
    writes.push(mergeJsonWrite(opts.targetDir, LOCAL_SETTINGS, { extraKnownMarketplaces: marketEntry }));
    const gi = exists('.gitignore') ? fs.readFileSync(path.join(opts.targetDir, '.gitignore'), 'utf8') : '';
    if (!gi.split(/\r?\n/).includes(LOCAL_SETTINGS)) writes.push({ rel: '.gitignore', content: (gi && !gi.endsWith('\n') ? gi + '\n' : gi) + LOCAL_SETTINGS + '\n', action: gi ? 'append' : 'create' });
  }

  const claude = render(tpl('CLAUDE.md.tmpl'), vars);
  if (exists('CLAUDE.md')) writes.push({ rel: 'CLAUDE.harness.md', content: claude, action: 'beside' });
  else writes.push({ rel: 'CLAUDE.md', content: claude, action: 'create' });

  for (const n of RULE_NAMES) {
    const rel = `.claude/rules/harness-${n}.md`;
    writes.push({ rel, content: render(tpl(`rules/harness-${n}.md.tmpl`), vars), action: exists(rel) ? 'overwrite' : 'create' });
  }

  writes.push({ rel: 'githooks/commit-msg', content: tpl('githooks/commit-msg'), action: exists('githooks/commit-msg') ? 'overwrite' : 'create', mode: 0o755 });
  const regexRel = config.guards.commit.regexFile;
  if (exists(regexRel) && !opts.force) refusals.push(`${regexRel} exists (you may have edited it); pass --force to overwrite it`);
  writes.push({ rel: regexRel, content: render(tpl('githooks/conventional-regex.txt.tmpl'), vars), action: exists(regexRel) ? 'overwrite' : 'create' });

  writes.push({ rel: '.github/workflows/harness.yml', content: render(tpl('ci.yml.tmpl'), vars), action: exists('.github/workflows/harness.yml') ? 'overwrite' : 'create' });

  const checklist = [
    'git config core.hooksPath githooks',
    `claude plugin marketplace add ${opts.marketplace}`,
    `claude plugin install ${PLUGIN_KEY}`,
    exists('CLAUDE.md') ? 'merge CLAUDE.harness.md into your CLAUDE.md, then delete it' : 'fill in the placeholders in CLAUDE.md',
    'restart Claude Code (or /reload) so the plugin hooks load; the session preflight will confirm',
  ];
  return { writes, refusals, checklist };
}

function mergeJsonWrite(targetDir, rel, fragment) {
  const abs = path.join(targetDir, rel);
  let existing = {};
  if (fs.existsSync(abs)) {
    try { existing = JSON.parse(fs.readFileSync(abs, 'utf8')); } catch (e) { throw new Error(`${rel} is not valid JSON: ${e.message}`); }
  }
  return { rel, content: JSON.stringify(deepMergeSettings(existing, fragment), null, 2) + '\n', action: fs.existsSync(abs) ? 'merge' : 'create' };
}

export function applyWrites(targetDir, writes, fsm = fs) {
  for (const w of writes) {
    const abs = path.join(targetDir, w.rel);
    fsm.mkdirSync(path.dirname(abs), { recursive: true });
    fsm.writeFileSync(abs, w.content);
    if (w.mode) fsm.chmodSync(abs, w.mode);
  }
}

export function init(opts, io) {
  let plan;
  try { plan = planInit(opts); } catch (e) { io.stderr.write(`cc-harness init: ${e.message}\n`); return 1; }
  if (plan.refusals.length) {
    io.stderr.write(`cc-harness init: refusing to continue; nothing was written.\n- ${plan.refusals.join('\n- ')}\n`);
    return 1;
  }
  const width = Math.max(...plan.writes.map((w) => w.rel.length));
  for (const w of plan.writes) io.stdout.write(`${opts.dryRun ? '[dry-run] ' : ''}${w.action.padEnd(9)} ${w.rel.padEnd(width)}\n`);
  if (opts.dryRun) return 0;
  applyWrites(opts.targetDir, plan.writes);
  io.stdout.write(`\ncc-harness ${opts.pluginVersion ?? pluginVersion()} installed into ${opts.targetDir} (preset ${opts.preset}).\nNext steps:\n${plan.checklist.map((c, i) => `  ${i + 1}. ${c}`).join('\n')}\n`);
  return 0;
}

export function syncRules(opts, io) {
  const targetDir = path.resolve(opts.targetDir);
  const version = opts.pluginVersion ?? pluginVersion();
  const loaded = loadConfig(targetDir, opts.presetsDir ? { presetsDir: opts.presetsDir } : {});
  if (loaded.status !== 'ok') { io.stderr.write(`cc-harness sync-rules: ${loaded.status === 'absent' ? '.claude/harness.json not found; run init first' : loaded.errors.join('; ')}\n`); return 1; }
  const config = loaded.config;
  const preset = config.preset === 'custom' ? {} : (loadPreset(config.preset, opts.presetsDir ?? defaultPresetsDir()) ?? {});
  const regexAbs = path.join(targetDir, config.guards.commit.regexFile);
  const rules = fs.existsSync(regexAbs) ? parseRegexFile(fs.readFileSync(regexAbs, 'utf8')) : { types: DEFAULT_TYPES, scopes: [] };
  const vars = templateVars({ config, preset, types: rules.types.length ? rules.types : DEFAULT_TYPES, scopes: rules.scopes, pluginVersion: version, projectName: path.basename(targetDir) });
  const tdir = opts.templatesDir ?? templatesDir();
  const writes = RULE_NAMES.map((n) => ({ rel: `.claude/rules/harness-${n}.md`, content: render(fs.readFileSync(path.join(tdir, 'rules', `harness-${n}.md.tmpl`), 'utf8'), vars), action: 'overwrite' }));
  writes.push({ rel: 'githooks/commit-msg', content: fs.readFileSync(path.join(tdir, 'githooks', 'commit-msg'), 'utf8'), action: 'overwrite', mode: 0o755 });
  applyWrites(targetDir, writes);
  io.stdout.write(`cc-harness sync-rules: refreshed ${writes.length} files to v${version}\n`);
  return 0;
}
```

Wire `lib/cli.mjs`:
```js
import { init, syncRules, parseInitArgs } from './init.mjs';
async function runInit(args, io) { return init(parseInitArgs(args, io.env), io); }
async function runSyncRules(args, io) { return syncRules({ targetDir: argValue(args, '--target') ?? io.env.CLAUDE_PROJECT_DIR ?? process.cwd() }, io); }
```

- [ ] **Step 4: Run the whole suite**

Run: `node --test test/*.test.mjs`
Expected: all PASS.

- [ ] **Step 5: Try it by hand in a scratch dir**

Run:
```bash
S=$(mktemp -d) && echo '{}' > "$S/package.json" && node plugins/cc-harness/bin/harness.mjs init --target "$S" --scopes api,web --dry-run && node plugins/cc-harness/bin/harness.mjs init --target "$S" --scopes api,web && cat "$S/.claude/settings.local.json" && node plugins/cc-harness/bin/harness.mjs doctor --target "$S"
```
Expected: dry-run lists files without writing; real run writes them; because the default marketplace is this checkout, `settings.local.json` carries a `directory` source; doctor reports only the `core.hooksPath` warning (no `git init` in the scratch dir) and node/config as ok.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(cli): add init and sync-rules"
```

---

### Task 8: Skills, preset recipe, README

**Files:**
- Create: `plugins/cc-harness/skills/init/SKILL.md`
- Create: `plugins/cc-harness/skills/doctor/SKILL.md`
- Create: `docs/presets.md`
- Modify: `README.md`

- [ ] **Step 1: Write the init skill**

`plugins/cc-harness/skills/init/SKILL.md`:
```markdown
---
name: init
description: Bootstrap cc-harness in the current project (config, settings, rules, git hook, CI) or refresh the harness-owned rules after a plugin update. Use when the user says "set up cc-harness", "init the harness", "install the guardrails", or "sync the harness rules".
---

# cc-harness init

## Detect the preset

Look at the project root:
- `package.json` present → preset `ts`
- otherwise → preset `custom` (the user fills in globs and checks by hand; point them at `${CLAUDE_PLUGIN_ROOT}/../../docs/presets.md` or the README section "Writing a preset")

Tell the user which preset you detected and why. Let them override.

## Ask two things, once

1. Commit scopes as a comma-separated list (for example `api,web,ci`). Empty means any lower-case word is accepted as a scope.
2. Whether attribution trailers (Co-Authored-By, Claude-Session) should be rejected. Default yes. If no, after init set `guards.commit.rejectAttributionTrailers` to `false` in `.claude/harness.json`.

Do not ask about types unless the user brings it up; the default set is `feat fix docs test refactor perf build ci chore revert` (`--types` overrides it).

## Run the installer

Always dry-run first and show the output:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/harness.mjs" init --target "$CLAUDE_PROJECT_DIR" --preset <preset> --scopes <scopes> --dry-run
```

Then run it for real without `--dry-run`. The installer writes into `.claude/`, which the Bash sandbox may deny; if the command fails with "Operation not permitted", run it with the sandbox disabled, or ask the user to run it themselves by typing `!` followed by the same command.

If the installer refuses because `.claude/harness.json` or the regex file exists, do **not** add `--force` on your own. Show the refusal and ask.

## Refresh after a plugin update

When the session preflight says rules are stale, run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/harness.mjs" sync-rules --target "$CLAUDE_PROJECT_DIR"
```

## Finish

Relay the installer's numbered next steps verbatim (hooksPath, marketplace add, plugin install, CLAUDE.md placeholders). Then run `/cc-harness:doctor`.
```

- [ ] **Step 2: Write the doctor skill**

`plugins/cc-harness/skills/doctor/SKILL.md`:
```markdown
---
name: doctor
description: Check that cc-harness is correctly installed in the current project and explain every finding. Use when the user asks "is the harness working", "why did a guard not fire", "check the harness", or when the session preflight reports findings.
---

# cc-harness doctor

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/harness.mjs" doctor --target "$CLAUDE_PROJECT_DIR"
```

Report every line marked ⚠ or ✖ to the user with the fix:

| Finding | Fix |
|---|---|
| `.claude/harness.json not found` | run `/cc-harness:init` |
| `harness.json is invalid` | open the file, fix the listed key; every key is documented in the README |
| `marker file X not found` | the preset expects X at the project root; create it or set `project.markerFile` to `""` |
| `commit regex file not found` | run `/cc-harness:init` (refuses if other files exist; then create `githooks/conventional-regex.txt` by hand: line 1 regex, then `# types:` and `# scopes:` lines) |
| `core.hooksPath is not "githooks"` | `git config core.hooksPath githooks` |
| `rules ... missing` or `stamped vX but plugin is vY` | `node "${CLAUDE_PLUGIN_ROOT}/bin/harness.mjs" sync-rules --target "$CLAUDE_PROJECT_DIR"` |
| `node vN is below 18` | install Node 18 or newer; hooks cannot run otherwise |

A guard that "did not fire" almost always means one of: no `harness.json`, the marker file is absent, the guard is disabled in `guards.<name>.enabled`, or the path matched `ignoreGlobs`. Check those four in order.
```

- [ ] **Step 3: Write docs/presets.md**

```markdown
# Writing a cc-harness preset

A preset is a JSON file in `plugins/cc-harness/presets/<name>.json`. It is merged under the consumer's `.claude/harness.json` (consumer keys win), which is itself merged under the built-in defaults. `preset: "custom"` means no preset file. Every key is optional.

The shipped `ts.json` is the worked example; each section below quotes it.

## project

| key | meaning | ts.json |
|---|---|---|
| `markerFile` | file at the project root that must exist for any guard to run; keeps a globally enabled plugin out of unrelated repos | `package.json` |
| `sourceGlobs` | edits to these arm the quality gate and mark the session dirty for the stop gate | `**/*.ts`, `**/*.tsx`, `**/*.js`, … |
| `testGlobs` | edits to existing files matching these prompt; commands mentioning them are inspected | `**/*.test.*`, `**/*.spec.*`, `**/__tests__/**` |
| `ignoreGlobs` | checked first; a match disarms every path-based guard | default: node_modules, dist, build, .git |

Globs: `*` never crosses `/`; `**/` matches zero or more directories; a glob without `/` is also tried against the basename.

## commands

| key | meaning | ts.json |
|---|---|---|
| `safe` | tool words that may mention a test file without prompting (test runners, linters in check mode). Merged with the built-in read-only list (`cat`, `grep`, `ls`, …). `git` is handled specially: only read-only subcommands are safe. | `node tsc vitest jest eslint prettier tsx ts-node` |
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

## ci (preset only)

`ci.setupSteps` is a list of GitHub Actions step objects rendered before the check steps in `.github/workflows/harness.yml`. Guards ignore it.

## Checklist for a new preset

1. Copy `ts.json`, change every value, delete what does not apply.
2. Run `node --test test/*.test.mjs`; `presets.test.mjs` validates every preset file.
3. Bootstrap a scratch project with `--preset <name>` and confirm: editing an existing test prompts, running the test suite does not, a bad commit message is denied, breaking a fast check returns its output.
4. Add a row to the README's preset table.
```

- [ ] **Step 4: Write the README**

Replace `README.md`:
```markdown
# cc-harness

Config-driven guardrails and a one-command bootstrap for Claude Code projects. Zero dependencies; Node 18+.

**What it enforces, once `.claude/harness.json` exists in a project:**

| Guard | Event | Behaviour |
|---|---|---|
| test | before Write/Edit/Bash | prompts before an existing test file is edited, deleted, or rewritten by a command; running tests is free |
| commit | before Bash | denies `git commit` unless the subject matches the regex in `githooks/conventional-regex.txt`; rejects attribution trailers (configurable) |
| quality | after Write/Edit | runs the fast checks (typecheck, lint, format) and hands the failure back to Claude with "fix this before continuing" |
| git | before Bash | prompts before `reset --hard`, `checkout .`, `clean -f`, `push --force`, `branch -D`, `stash drop` |
| stop | when Claude wants to end a turn | if source files changed this session, runs the named checks and refuses to stop while they fail (bounded by `maxBlocks`) |
| preflight | session start | prints a status block: version, preset, active guards, skipped checks, findings |

A project without `.claude/harness.json` sees nothing.

The stop gate arms only on edits made through Claude's Write/Edit tools. A source change made by a shell command (`sed -i`, a formatter, `git apply`) does not arm it; the quality gate does not see those either.

## Install

```sh
claude plugin marketplace add malek/cc-harness      # replace with your fork's owner/repo if you forked
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

`init` writes: `.claude/harness.json` (two lines: version and preset), `.claude/settings.json` (plugin enabled, a permission profile: read-only git and the check commands allowed, `git push`/`rm`/formatters ask, secrets denied), `CLAUDE.md` (or `CLAUDE.harness.md` beside an existing one), five `.claude/rules/harness-*.md` files, `githooks/commit-msg` + `githooks/conventional-regex.txt`, and `.github/workflows/harness.yml`. It never overwrites `harness.json` or the regex file without `--force`.

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

Disable a guard: `"guards": { "git": { "enabled": false } }`. Change the commit format: edit line 1 of `githooks/conventional-regex.txt` (keep the `# types:` / `# scopes:` lines for readable error messages). Full key reference: [docs/presets.md](docs/presets.md).

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
harness doctor             # explain the install state
harness sync-rules         # refresh harness-*.md rules and the git hook after a plugin update
```

## Develop

```sh
node --test test/*.test.mjs
claude plugin validate plugins/cc-harness --strict
```

This repository runs cc-harness on itself (`.claude/harness.json`, preset `custom`).
```

- [ ] **Step 5: Validate and commit**

Run: `claude plugin validate plugins/cc-harness --strict && node --test test/*.test.mjs`
Expected: validation passes (two skills found), tests PASS.

```bash
git add -A
git commit -m "docs: add skills, preset recipe, and readme"
```

---

### Task 9: Dogfood and end-to-end verification

This task is run by the controller, not a subagent, because it needs the sandbox disabled for `.claude/` writes and interactive Claude Code sessions.

**Files:**
- Create via `init --preset custom`, then edit: `.claude/harness.json`, `.claude/settings.json`, `CLAUDE.md`, `.claude/rules/harness-*.md`, `githooks/*`, `.github/workflows/harness.yml`
- Modify: `.gitignore`

- [ ] **Step 1: Run init on this repo (sandbox disabled)**

```bash
node plugins/cc-harness/bin/harness.mjs init --target "$PWD" --preset custom --scopes cli,guards,config,render,presets,skills,docs,ci --types feat,fix,docs,test,refactor,build,ci,chore --name cc-harness
git config core.hooksPath githooks
```
Expected: creates the file set; `.claude/settings.local.json` holds the `directory` marketplace pointing at this checkout and is gitignored.

- [ ] **Step 2: Hand-edit `.claude/harness.json` to the dogfood config**

```json
{
  "version": 1,
  "preset": "custom",
  "project": {
    "markerFile": ".claude-plugin/marketplace.json",
    "sourceGlobs": ["plugins/**/*.mjs", "plugins/**/*.json", "plugins/**/*.tmpl", "plugins/**/commit-msg"],
    "testGlobs": ["test/**/*.test.mjs"]
  },
  "commands": { "safe": ["node"], "write": [{ "cmd": "node", "whenFlags": ["-e", "--eval", "-p", "--print"] }] },
  "checks": [
    { "name": "syntax", "cmd": "for f in plugins/cc-harness/bin/*.mjs plugins/cc-harness/lib/*.mjs plugins/cc-harness/lib/guards/*.mjs test/*.mjs test/helpers/*.mjs; do node --check \"$f\" || exit 1; done", "fast": true },
    { "name": "validate", "cmd": "claude plugin validate plugins/cc-harness --strict", "ifExists": "plugins/cc-harness/.claude-plugin/plugin.json", "fast": true },
    { "name": "tests", "cmd": "node --test test/*.test.mjs" }
  ],
  "guards": { "stop": { "checks": ["syntax", "tests"] } }
}
```
Then run `node plugins/cc-harness/bin/harness.mjs sync-rules --target "$PWD"` so the rules reflect these checks, and fill in `CLAUDE.md` placeholders (what the project is: two sentences; layout: the File Structure list from this plan, condensed; sandbox notes: `.claude/` and `.git` writes need the sandbox disabled).

- [ ] **Step 3: Enable superpowers alongside, check settings**

`.claude/settings.json` must contain `enabledPlugins` with both `cc-harness@cc-harness` and `superpowers@claude-plugins-official`. Use the Edit tool (sandbox denies Bash writes to this file).

- [ ] **Step 4: Commit the dogfood files**

```bash
git add -A
git commit -m "chore(ci): dogfood cc-harness on its own repository"
```
Expected: the commit-msg hook accepts it. Then confirm the hook rejects: `git commit --allow-empty -m "bad message"` → fails; nothing committed.

- [ ] **Step 5: Register the marketplace and install the plugin locally**

```bash
claude plugin marketplace add "$PWD"
claude plugin install cc-harness@cc-harness
claude plugin details cc-harness
```

- [ ] **Step 6: Live verification in this repo (new Claude Code session)**

Start a new session in this directory and confirm, in order:
1. The first context contains the five-line preflight block with `preset custom` and `doctor: all checks passed`.
2. Ask Claude to run `git commit --allow-empty -m "update code"` → the commit guard denies with the types list.
3. Ask Claude to edit `test/glob.test.mjs` → a permission prompt from the test guard appears.
4. Ask Claude to insert a syntax error into `plugins/cc-harness/lib/glob.mjs` → the quality gate returns the `node --check` failure with "Fix this before continuing"; ask it to revert.
5. Ask Claude to change an assertion in a test so it fails, then to end the turn → the stop gate blocks with the failing test output; fix → the turn ends. (Confirms Stop JSON is honoured.)
6. `ls ~/.claude/plugins/data/cc-harness/sessions/` (or wherever `CLAUDE_PLUGIN_DATA` points; print it from a hook if unsure) shows one marker per session id.

- [ ] **Step 7: Live verification in a scratch TS project**

```bash
S=$(mktemp -d) && cd "$S" && git init -q && npm init -y >/dev/null && npm i -D typescript vitest >/dev/null && printf '{"compilerOptions":{"strict":true}}' > tsconfig.json && mkdir src && printf 'export const add = (a: number, b: number) => a + b;\n' > src/add.ts && printf "import { expect, test } from 'vitest';\nimport { add } from './add';\ntest('add', () => { expect(add(1, 2)).toBe(3); });\n" > src/add.test.ts
node <plugin-root>/bin/harness.mjs init --target "$S" --scopes core && git -C "$S" config core.hooksPath githooks && git -C "$S" add -A && git -C "$S" commit -qm "feat(core): add"
```
Then in a Claude Code session in `$S`: repeat checks 2–5 above (edit `src/add.test.ts`, break `src/add.ts` typing, leave a failing test and try to stop). Also confirm two things: a project with `harness.json` deleted sees no prompts at all, and two concurrent sessions in `$S` keep separate markers (dirty one session, stop in the other → no block).

- [ ] **Step 8: Verify the `github` marketplace shape**

After the repo is pushed, in a scratch project: `claude plugin marketplace add <owner>/cc-harness`, then inspect `~/.claude/plugins/known_marketplaces.json` and compare the recorded source object with what `init` writes into `extraKnownMarketplaces` (`{ source: 'github', repo }`). If they differ, fix `planInit` and its test.

- [ ] **Step 9: Record results**

Append a "Verified on 2026-09-XX" note to `README.md` under Develop listing the Claude Code version used, and commit:
```bash
git add -A
git commit -m "docs: record end-to-end verification"
```

---

## Self-review notes

- Spec coverage: §1 layout → T0/T1; §2 schema → T1 (config), T6 (preset); §3 guards → T2 (test, git), T3 (commit), T4 (quality, stop), T5 (preflight); §4 bootstrap, rules, permissions, skills → T6, T7, T8; §5 testing, dogfood, release → every task's tests, T9; risks table → config-absent test (T2), maxBlocks (T4), session markers (T4), rules sync (T7), node prerequisite (T5 doctor).
- Type consistency: `evaluate(ctx)` signature and `decision` shape are fixed in the File Structure block and used unchanged in T2–T5; `runChecks` result shape is defined in T4 and consumed by T4/T5; `RULE_NAMES` lives in `doctor.mjs` (T5) and is imported by T6 tests and T7; `argValue` is exported from `cli.mjs` in T5 and reused in T7.
- Known deliberate limitation: `splitSegments` does not understand subshells `$( )` or backticks; a destructive command hidden inside one is not seen. Documented in `docs/presets.md` (T8) under commands.
