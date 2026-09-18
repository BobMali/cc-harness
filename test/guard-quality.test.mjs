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

test('paths outside the project are out of scope: no marker, no checks', () => {
  const p = makeProject({}); const d = makeDataDir();
  try {
    for (const file of ['../outside.ts', '../../x/outside.test.ts']) {
      const { d: dec, log } = run(p, d, file);
      assert.equal(dec, null, file);
      assert.deepEqual(log, [], file);
    }
    // run() joins onto the project dir, so the absolute case needs a direct call
    const log = [];
    const input = { tool_name: 'Write', tool_input: { file_path: '/etc/outside.ts' }, session_id: 'sess' };
    assert.equal(evaluate({ event: 'PostToolUse', input, config: mergeConfig(DEFAULTS, base), projectDir: p.dir, dataDir: d.dir, exec: fakeExec(log), fs }), null);
    assert.deepEqual(log, []);
    assert.equal(readMarker(d.dir, 'sess'), null);
  } finally { p.cleanup(); d.cleanup(); }
});
