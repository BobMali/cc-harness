import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { planInit, init, syncRules, syncCi, parseInitArgs, defaultMarketplace } from '../plugins/cc-harness/lib/init.mjs';
import { loadConfig } from '../plugins/cc-harness/lib/config.mjs';
import { argValue } from '../plugins/cc-harness/lib/cli.mjs';
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
    assert.ok(s.permissions.deny.includes('Read(**/.env)'));
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

test('F1: dot-relative marketplace paths are treated as local, not github, and resolve to an absolute path', () => {
  const p = makeProject({});
  try {
    for (const m of ['../x', './x']) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-harness-f1-'));
      const o = io();
      assert.equal(init(base(dir, { marketplace: m }), o), 0);
      const local = JSON.parse(fs.readFileSync(path.join(dir, '.claude/settings.local.json'), 'utf8'));
      assert.equal(local.extraKnownMarketplaces['cc-harness'].source.source, 'directory');
      assert.ok(path.isAbsolute(local.extraKnownMarketplaces['cc-harness'].source.path), `path not absolute for ${m}`);
      const settings = JSON.parse(fs.readFileSync(path.join(dir, '.claude/settings.json'), 'utf8'));
      assert.ok(!('extraKnownMarketplaces' in settings));
      assert.ok(o.stdout.text().includes(local.extraKnownMarketplaces['cc-harness'].source.path), 'checklist should show the resolved absolute path');
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } finally { p.cleanup(); }
});

test('F1: owner/repo with a dot in the repo name is still github', () => {
  const p = makeProject({});
  try {
    init(base(p.dir, { marketplace: 'a/b.c' }), io());
    const s = JSON.parse(p.read('.claude/settings.json'));
    assert.deepEqual(s.extraKnownMarketplaces['cc-harness'], { source: { source: 'github', repo: 'a/b.c' } });
  } finally { p.cleanup(); }
});

test('F2: deny profile matches the exact fixed list', () => {
  const p = makeProject({ files: { 'package.json': '{}' } });
  try {
    init(base(p.dir), io());
    const s = JSON.parse(p.read('.claude/settings.json'));
    assert.deepEqual(s.permissions.deny, [
      'Read(**/.env)', 'Read(**/.env.*)', 'Edit(**/.env)', 'Edit(**/.env.*)',
      'Read(**/*.pem)', 'Edit(**/*.pem)', 'Read(**/credentials.*)', 'Edit(**/credentials.*)',
      'Read(~/.ssh/**)', 'Edit(~/.ssh/**)', 'Read(~/.gnupg/**)', 'Edit(~/.gnupg/**)',
    ]);
  } finally { p.cleanup(); }
});

test('F3: syncRules warns and points at the regex file when it has no "# types:" line', () => {
  const p = makeProject({ files: { 'package.json': '{}' } });
  try {
    init(base(p.dir), io());
    p.write('githooks/conventional-regex.txt', '^(feat|fix)(\\((api)\\))?!?: .+$\n');
    const o = io();
    assert.equal(syncRules({ targetDir: p.dir, pluginVersion: '0.2.0' }, o), 0);
    assert.match(o.stderr.text(), /no "# types:" line/);
    const commits = p.read('.claude/rules/harness-commits.md');
    assert.match(commits, /see githooks\/conventional-regex\.txt/);
    assert.doesNotMatch(commits, /docs test refactor/);
  } finally { p.cleanup(); }
});

test('item3: a hand-edited rejectAttributionTrailers is honoured by init --force and by sync-rules', () => {
  const p = makeProject({ files: { 'package.json': '{}' } });
  try {
    init(base(p.dir), io());
    const editHarness = () => {
      const h = JSON.parse(p.read('.claude/harness.json'));
      h.guards = { commit: { rejectAttributionTrailers: false } };
      p.write('.claude/harness.json', JSON.stringify(h, null, 2));
    };
    editHarness();
    assert.equal(init(base(p.dir, { force: true }), io()), 0);
    assert.match(p.read('githooks/commit-msg'), /:-0\}/);
    p.write('githooks/commit-msg', 'stale');
    assert.equal(syncRules({ targetDir: p.dir, pluginVersion: '0.2.0' }, io()), 0);
    assert.match(p.read('githooks/commit-msg'), /:-0\}/);
  } finally { p.cleanup(); }
});

test('item3: a custom regexFile is rendered into the hook', () => {
  const p = makeProject({ files: { 'package.json': '{}' } });
  try {
    init(base(p.dir), io());
    const h = JSON.parse(p.read('.claude/harness.json'));
    h.guards = { commit: { regexFile: 'githooks/my-rules.txt' } };
    p.write('.claude/harness.json', JSON.stringify(h, null, 2));
    assert.equal(init(base(p.dir, { force: true }), io()), 0);
    assert.match(p.read('githooks/commit-msg'), /githooks\/my-rules\.txt/);
  } finally { p.cleanup(); }
});

test('item1: init --force preserves the user harness.json (custom regexFile + rejectAttributionTrailers) instead of the preset stub', () => {
  const p = makeProject({ files: { 'package.json': '{}' } });
  try {
    init(base(p.dir), io());
    p.write('githooks/my-rules.txt', p.read('githooks/conventional-regex.txt'));
    const h = JSON.parse(p.read('.claude/harness.json'));
    h.guards = { commit: { regexFile: 'githooks/my-rules.txt', rejectAttributionTrailers: false } };
    p.write('.claude/harness.json', JSON.stringify(h, null, 2));
    assert.equal(init(base(p.dir, { force: true }), io()), 0);
    const after = JSON.parse(p.read('.claude/harness.json'));
    assert.equal(after.guards.commit.regexFile, 'githooks/my-rules.txt');
    assert.equal(after.guards.commit.rejectAttributionTrailers, false);
    const hook = p.read('githooks/commit-msg');
    assert.match(hook, /my-rules\.txt/);
    assert.match(hook, /:-0\}/);
    const loaded = loadConfig(p.dir);
    assert.equal(loaded.status, 'ok');
    assert.equal(loaded.config.guards.commit.regexFile, 'githooks/my-rules.txt');
  } finally { p.cleanup(); }
});

test('item5: permission profile skips generic-runner/write-owned checks from allow, and asks for path-qualified write commands too', () => {
  const p = makeProject({ files: { 'package.json': '{}' } });
  try {
    init(base(p.dir), io());
    const s = JSON.parse(p.read('.claude/settings.json'));
    assert.ok(!s.permissions.allow.includes('Bash(node_modules/.bin/prettier:*)'));
    assert.ok(!s.permissions.allow.includes('Bash(node_modules/.bin/eslint:*)'));
    assert.ok(s.permissions.allow.includes('Bash(node_modules/.bin/tsc:*)'));
    assert.ok(s.permissions.allow.includes('Bash(node_modules/.bin/vitest:*)'));
    assert.ok(s.permissions.ask.includes('Bash(node_modules/.bin/prettier --write:*)'));
    assert.ok(s.permissions.ask.includes('Bash(prettier --write:*)'));
  } finally { p.cleanup(); }
});

test('item5: a check command starting with a shell keyword yields no bare allow entry', () => {
  const p = makeProject({});
  try {
    p.write('.claude/harness.json', JSON.stringify({ version: 1, preset: 'custom', checks: [{ name: 'x', cmd: 'for f in x; do echo $f; done', fast: true }] }));
    const plan = planInit(base(p.dir, { preset: 'custom', force: true }));
    const settings = JSON.parse(plan.writes.find((w) => w.rel === '.claude/settings.json').content);
    assert.ok(!settings.permissions.allow.includes('Bash(for:*)'));
  } finally { p.cleanup(); }
});

test('item8: argValue and parseInitArgs val treat a flag-shaped next token as absent, not a value', () => {
  assert.equal(argValue(['--target', '--force'], '--target'), undefined);
  assert.equal(argValue(['--target', '/t'], '--target'), '/t');
  const o = parseInitArgs(['--preset', '--force', '--target', '/t'], {});
  assert.equal(o.preset, 'ts');   // '--force' looks like a flag, not a value for --preset
  assert.equal(o.force, true);
  assert.equal(o.targetDir, '/t');
});

test('item8: defaultMarketplace falls back to known_marketplaces.json before the hardcoded default', () => {
  const p = makeProject({});
  const emptyCandidate = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-harness-candidate-'));
  try {
    const gh = p.write('known-gh.json', JSON.stringify({ 'cc-harness': { source: { source: 'github', repo: 'acme/cc-harness' } } }));
    assert.equal(defaultMarketplace({ candidateDir: emptyCandidate, knownMarketplacesFile: gh }), 'acme/cc-harness');
    const dir = p.write('known-dir.json', JSON.stringify({ 'cc-harness': { source: { source: 'directory', path: '/local/checkout' } } }));
    assert.equal(defaultMarketplace({ candidateDir: emptyCandidate, knownMarketplacesFile: dir }), '/local/checkout');
    assert.equal(defaultMarketplace({ candidateDir: emptyCandidate, knownMarketplacesFile: '/does/not/exist.json' }), 'BobMali/cc-harness');
    assert.equal(defaultMarketplace({ candidateDir: emptyCandidate, knownMarketplacesFile: p.write('known-bad.json', 'not json') }), 'BobMali/cc-harness');
  } finally { p.cleanup(); fs.rmSync(emptyCandidate, { recursive: true, force: true }); }
});

test('parseInitArgs', () => {
  const o = parseInitArgs(['--preset', 'custom', '--types', 'a,b', '--scopes=x', '--force', '--dry-run', '--target', '/t', '--marketplace', 'o/r'], {});
  assert.equal(o.preset, 'custom'); assert.deepEqual(o.types, ['a', 'b']); assert.deepEqual(o.scopes, ['x']);
  assert.equal(o.force, true); assert.equal(o.dryRun, true); assert.equal(o.targetDir, '/t'); assert.equal(o.marketplace, 'o/r');
  const d = parseInitArgs([], { CLAUDE_PROJECT_DIR: '/proj' });
  assert.equal(d.targetDir, '/proj'); assert.equal(d.preset, 'ts'); assert.equal(d.projectName, 'proj'); assert.ok(d.types.includes('feat'));
});

test('syncCi re-renders only the workflow, from harness.json including its ci block', () => {
  const p = makeProject({ files: { 'package.json': '{}' } });
  try {
    init(base(p.dir), io());
    const cfg = JSON.parse(p.read('.claude/harness.json'));
    cfg.checks = [{ name: 'tests', cmd: 'node --test' }]; cfg.guards = { stop: { checks: ['tests'] } };   // the preset's stop list names checks we dropped
    cfg.ci = { setupSteps: [{ run: 'echo setup' }], extraSteps: [{ name: 'after', run: 'echo after' }] };
    p.write('.claude/harness.json', JSON.stringify(cfg));
    p.write('.github/workflows/harness.yml', 'stale'); p.write('CLAUDE.md', 'mine'); p.write('.claude/rules/harness-done.md', 'stale');
    assert.equal(syncCi({ targetDir: p.dir, pluginVersion: '0.2.0' }, io()), 0);
    const yml = p.read('.github/workflows/harness.yml');
    assert.match(yml, /- run: 'echo setup'/);
    assert.match(yml, /- name: tests\n\s+run: 'node --test'/);
    assert.match(yml, /- name: after\n\s+run: 'echo after'/);
    assert.match(yml, /CC_HARNESS_REJECT_TRAILERS: "1"/);
    assert.equal(p.read('CLAUDE.md'), 'mine'); assert.equal(p.read('.claude/rules/harness-done.md'), 'stale');
    const o = io();
    fs.rmSync(path.join(p.dir, '.claude/harness.json'));
    assert.equal(syncCi({ targetDir: p.dir }, o), 1);
    assert.match(o.stderr.text(), /harness\.json not found/);
  } finally { p.cleanup(); }
});

test('re-init retires harness-owned permission entries the new config no longer produces, keeps user entries, and replaces the marketplace source', () => {
  const p = makeProject({ files: { 'package.json': '{}' } });
  try {
    assert.equal(init(base(p.dir, { preset: 'custom' }), io()), 0);
    const cfg = JSON.parse(p.read('.claude/harness.json'));
    cfg.checks = [{ name: 'lint', cmd: 'eslint .' }]; cfg.commands.write = [{ cmd: 'prettier', whenFlags: ['--write'] }];
    p.write('.claude/harness.json', JSON.stringify(cfg));
    assert.equal(init(base(p.dir, { preset: 'custom', force: true }), io()), 0);
    let s = JSON.parse(p.read('.claude/settings.json'));
    assert.ok(s.permissions.allow.includes('Bash(eslint:*)')); assert.ok(s.permissions.ask.includes('Bash(prettier --write:*)'));
    // user adds an entry of their own and one that coincides with a harness entry, then the config changes
    s.permissions.allow.push('Bash(mine:*)');
    p.write('.claude/settings.json', JSON.stringify(s));
    cfg.checks = [{ name: 'lint', cmd: 'biome check .' }]; cfg.commands.write = [];
    p.write('.claude/harness.json', JSON.stringify(cfg));
    assert.equal(init(base(p.dir, { preset: 'custom', force: true, marketplace: 'other/cc-harness' }), io()), 0);
    s = JSON.parse(p.read('.claude/settings.json'));
    assert.ok(!s.permissions.allow.includes('Bash(eslint:*)'), 'retired check allow entry removed');
    assert.ok(!s.permissions.ask.includes('Bash(prettier --write:*)'), 'retired write ask entry removed');
    assert.ok(s.permissions.allow.includes('Bash(biome:*)'));
    assert.ok(s.permissions.allow.includes('Bash(mine:*)'), 'user entry kept');
    assert.ok(s.permissions.ask.includes('Bash(git push:*)'), 'still-current harness entry kept');
    assert.deepEqual(JSON.parse(p.read('.claude/harness.owned.json')).permissions.allow, s.permissions.allow.filter((x) => x !== 'Bash(mine:*)'), 'the record mirrors what init wrote');
    assert.deepEqual(s.extraKnownMarketplaces['cc-harness'].source, { source: 'github', repo: 'other/cc-harness' });
  } finally { p.cleanup(); }
});
