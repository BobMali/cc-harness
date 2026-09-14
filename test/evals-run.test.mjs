import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runSuite, evaluateVector, makeLangProject, compare } from '../evals/run.mjs';
import { readJsonl } from '../evals/lib/corpus.mjs';
import { makeDataDir } from './helpers/project.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'test', 'fixtures', 'evals', 'corpus');
const CONFIGS = path.join(ROOT, 'evals', 'configs');

function copyFixture() {
  const d = makeDataDir();
  fs.cpSync(FIX, path.join(d.dir, 'corpus'), { recursive: true });
  return { dir: path.join(d.dir, 'corpus'), cleanup: d.cleanup };
}

test('evaluateVector runs the production guard path with stubbed exec', () => {
  const proj = makeLangProject('ts', CONFIGS); const data = makeDataDir();
  try {
    assert.ok(fs.existsSync(path.join(proj.dir, 'package.json')));            // marker created
    assert.ok(fs.existsSync(path.join(proj.dir, 'githooks', 'conventional-regex.txt')));
    const a = evaluateVector({ lang: 'ts', event: 'PreToolUse', tool: 'Bash', input: { command: 'rm src/a.test.ts' } }, proj, data.dir);
    assert.equal(a.kind, 'ask'); assert.equal(a.guard, 'test'); assert.match(a.reason, /test guard/);
    const b = evaluateVector({ lang: 'ts', event: 'PreToolUse', tool: 'Edit', input: { file_path: 'src/a.test.ts' }, fixture: { exists: ['src/a.test.ts'] } }, proj, data.dir);
    assert.equal(b.kind, 'ask');
    assert.ok(!fs.existsSync(path.join(proj.dir, 'src', 'a.test.ts')));        // fixture removed
    const c = evaluateVector({ lang: 'ts', event: 'PreToolUse', tool: 'Edit', input: { file_path: 'src/a.test.ts' } }, proj, data.dir);
    assert.equal(c.kind, 'pass');                                               // new test file passes
    const d = evaluateVector({ lang: 'ts', event: 'PostToolUse', tool: 'Edit', input: { file_path: 'src/a.ts' } }, proj, data.dir);
    assert.equal(d.kind, 'block'); assert.equal(d.guard, 'quality');   // armed: PostToolUse stub exec fails
    const e = evaluateVector({ lang: 'ts', event: 'PreToolUse', tool: 'Bash', input: { command: 'git commit -m "update code"' } }, proj, data.dir);
    assert.equal(e.kind, 'deny'); assert.equal(e.guard, 'commit');
    const f = evaluateVector({ lang: 'ts', event: 'PreToolUse', tool: 'Edit', input: { file_path: '../outside.test.ts' }, fixture: { exists: ['../outside.test.ts'] } }, proj, data.dir);
    assert.ok(!fs.existsSync(path.join(proj.dir, '..', 'outside.test.ts')));   // never writes outside the temp project
    assert.ok(['pass', 'ask'].includes(f.kind));
  } finally { proj.cleanup(); data.cleanup(); }
});

test('compare statuses', () => {
  const v = (expected) => ({ expected });
  assert.equal(compare(v(null), { kind: 'ask' }), 'unlabelled');
  assert.equal(compare(v({ kind: 'ask' }), { kind: 'ask', guard: 'test' }), 'match');
  assert.equal(compare(v({ kind: 'ask', guard: 'git' }), { kind: 'ask', guard: 'test' }), 'mismatch');
  assert.equal(compare(v({ kind: 'ask', known_gap: true }), { kind: 'pass' }), 'known-gap');
  assert.equal(compare(v({ kind: 'ask', known_gap: true }), { kind: 'ask' }), 'gap-closed');
});

test('runSuite: mismatch outranks unlabelled, --update fixes mined only', () => {
  const c = copyFixture();
  try {
    const r1 = runSuite({ corpusDir: c.dir, configsDir: CONFIGS, quiet: true });
    assert.equal(r1.exitCode, 1);   // mismatch (ts-000005) outranks unlabelled
    const by = Object.fromEntries(r1.results.map((x) => [x.vector.id, x.status]));
    assert.equal(by['ts-000003'], 'unlabelled'); assert.equal(by['ts-000005'], 'mismatch');
    assert.equal(by['ts-000010'], 'match'); assert.equal(by['ts-000011'], 'known-gap'); assert.equal(by['ts-000012'], 'gap-closed');
    assert.match(r1.report, /ts-000005/); assert.match(r1.report, /known gaps: 1/); assert.match(r1.report, /gap closed/i);

    const r2 = runSuite({ corpusDir: c.dir, configsDir: CONFIGS, quiet: true, update: true });
    const mined = readJsonl(path.join(c.dir, 'mined', 'ts.jsonl'));
    assert.deepEqual(mined.find((v) => v.id === 'ts-000003').expected, { kind: 'ask', guard: 'test' });
    assert.deepEqual(mined.find((v) => v.id === 'ts-000005').expected, { kind: 'deny', guard: 'commit' });
    const adv = readJsonl(path.join(c.dir, 'adversarial', 'git.jsonl'));
    assert.equal(adv.find((v) => v.id === 'ts-000012').expected.known_gap, true);   // untouched
    assert.equal(r2.exitCode, 1);                                                    // gap-closed still fails

    fs.writeFileSync(path.join(c.dir, 'adversarial', 'git.jsonl'), adv.filter((v) => v.id !== 'ts-000012').map((v) => JSON.stringify(v)).join('\n') + '\n');
    const r3 = runSuite({ corpusDir: c.dir, configsDir: CONFIGS, quiet: true });
    assert.equal(r3.exitCode, 0);
    assert.match(r3.report, /ts +\| +test +\| /);   // a matrix row exists
  } finally { c.cleanup(); }
});

test('filters and CLI entry', () => {
  const c = copyFixture();
  try {
    const r = runSuite({ corpusDir: c.dir, configsDir: CONFIGS, quiet: true, source: 'adversarial', guard: 'git' });
    assert.ok(r.results.every((x) => x.vector.source === 'adversarial'));
    const p = spawnSync(process.execPath, [path.join(ROOT, 'evals', 'run.mjs'), '--corpus', c.dir, '--configs', CONFIGS, '--quiet'], { encoding: 'utf8' });
    assert.equal(p.status, 1);      // the fixture holds a deliberate mismatch
    assert.match(p.stdout, /unlabelled 1/);
  } finally { c.cleanup(); }
});
