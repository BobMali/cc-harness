import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { normalisePayload, vectorId, readJsonl, writeJsonl, loadCorpus, validateVector } from '../evals/lib/corpus.mjs';
import { makeDataDir } from './helpers/project.mjs';

test('normalisePayload collapses whitespace and picks the right field', () => {
  assert.equal(normalisePayload('Bash', { command: '  ls   -la \n\t x ' }), 'ls -la\nx');
  assert.equal(normalisePayload('Edit', { file_path: 'src/a.ts' }), 'src/a.ts');
  assert.equal(normalisePayload('Bash', {}), '');
});

test('vectorId is stable and whitespace-insensitive', () => {
  const a = vectorId('go', 'Bash', { command: 'go test ./...' });
  assert.match(a, /^go-[0-9a-f]{6}$/);
  assert.equal(a, vectorId('go', 'Bash', { command: 'go   test ./...' }));
  assert.notEqual(a, vectorId('ts', 'Bash', { command: 'go test ./...' }));
  assert.notEqual(a, vectorId('go', 'Edit', { file_path: 'go test ./...' }));
  assert.notEqual(vectorId('ts', 'Write', { file_path: 'a' }, true), vectorId('ts', 'Write', { file_path: 'a' }));
});

test('readJsonl / writeJsonl round-trip; bad lines report file:line', () => {
  const d = makeDataDir();
  try {
    const f = path.join(d.dir, 'a', 'b.jsonl');
    writeJsonl(f, [{ x: 1 }, { y: 'two' }]);
    assert.equal(fs.readFileSync(f, 'utf8'), '{"x":1}\n{"y":"two"}\n');
    assert.deepEqual(readJsonl(f), [{ x: 1 }, { y: 'two' }]);
    fs.writeFileSync(f, '{"x":1}\n\n{nope\n');
    assert.throws(() => readJsonl(f), /b\.jsonl:3: /);
  } finally { d.cleanup(); }
});

test('loadCorpus reads mined and adversarial dirs and tags source and file', () => {
  const d = makeDataDir();
  try {
    writeJsonl(path.join(d.dir, 'mined', 'go.jsonl'), [{ id: 'go-000001', lang: 'go', event: 'PreToolUse', tool: 'Bash', input: { command: 'ls' }, expected: null }]);
    writeJsonl(path.join(d.dir, 'adversarial', 'git.jsonl'), [{ id: 'ts-000002', lang: 'ts', event: 'PreToolUse', tool: 'Bash', input: { command: 'git reset --hard' }, expected: { kind: 'ask', guard: 'git' } }]);
    const { vectors, byFile } = loadCorpus(d.dir);
    assert.equal(vectors.length, 2);
    assert.equal(vectors.find((v) => v.id === 'go-000001').source, 'mined');
    assert.equal(vectors.find((v) => v.id === 'ts-000002').source, 'adversarial');
    assert.equal(byFile.size, 2);
    assert.ok([...byFile.keys()].every((k) => path.isAbsolute(k)));
  } finally { d.cleanup(); }
});

test('validateVector', () => {
  const ok = { id: 'ts-abcdef', lang: 'ts', event: 'PreToolUse', tool: 'Bash', input: { command: 'ls' }, expected: null, source: 'mined' };
  assert.deepEqual(validateVector(ok), []);
  const bad = { id: 'x', lang: 'zz', event: 'Stop', tool: 'Read', input: {}, expected: { kind: 'maybe' }, source: 'other' };
  const errs = validateVector(bad);
  for (const re of [/id/, /lang/, /event/, /tool/, /input/, /expected\.kind/, /source/]) assert.ok(errs.some((e) => re.test(e)), String(re));
  assert.ok(validateVector({ ...ok, tool: 'Edit', input: { command: 'x' } }).some((e) => /file_path/.test(e)));
});
