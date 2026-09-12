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
