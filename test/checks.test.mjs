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

test('defaultExec: a hung/aborted command surfaces the error up front', () => {
  const r = defaultExec('sleep 5', { cwd: '/tmp', timeoutMs: 200 });
  assert.notEqual(r.status, 0);
  assert.ok(r.output.startsWith('check aborted: ETIMEDOUT'), r.output);
});
