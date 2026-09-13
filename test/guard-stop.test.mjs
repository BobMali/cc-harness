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
