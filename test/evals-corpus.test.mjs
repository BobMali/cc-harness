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
  const a = vectorId('go', 'PreToolUse', 'Bash', { command: 'go test ./...' });
  assert.match(a, /^go-[0-9a-f]{6}$/);
  assert.equal(a, vectorId('go', 'PreToolUse', 'Bash', { command: 'go   test ./...' }));
  assert.notEqual(a, vectorId('ts', 'PreToolUse', 'Bash', { command: 'go test ./...' }));
  assert.notEqual(a, vectorId('go', 'PreToolUse', 'Edit', { file_path: 'go test ./...' }));
  assert.notEqual(a, vectorId('go', 'PostToolUse', 'Bash', { command: 'go test ./...' }));   // event is part of the key
  assert.notEqual(vectorId('ts', 'PreToolUse', 'Write', { file_path: 'a' }, true), vectorId('ts', 'PreToolUse', 'Write', { file_path: 'a' }));
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

test('readJsonl strips a leading BOM', () => {
  const d = makeDataDir();
  try {
    const f = path.join(d.dir, 'bom.jsonl');
    fs.writeFileSync(f, '﻿{"x":1}\n{"y":2}\n');
    assert.deepEqual(readJsonl(f), [{ x: 1 }, { y: 2 }]);
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

test('validateVector rejects non-object input without throwing', () => {
  assert.deepEqual(validateVector(null), ['vector must be an object']);
  assert.deepEqual(validateVector(42), ['vector must be an object']);
  assert.deepEqual(validateVector('x'), ['vector must be an object']);
});

// --- Fix round 1 -------------------------------------------------------

test('I5: writeJsonl writes atomically and leaves no .tmp sibling', () => {
  const d = makeDataDir();
  try {
    const f = path.join(d.dir, 'a', 'b.jsonl');
    writeJsonl(f, [{ x: 1 }, { y: 2 }]);
    assert.deepEqual(readJsonl(f), [{ x: 1 }, { y: 2 }]);
    assert.equal(fs.existsSync(`${f}.tmp`), false);
    // a second write (overwrite) also leaves no leftover tmp file
    writeJsonl(f, [{ z: 3 }]);
    assert.deepEqual(readJsonl(f), [{ z: 3 }]);
    assert.equal(fs.existsSync(`${f}.tmp`), false);
  } finally { d.cleanup(); }
});

test('T4: an edit-tool vector may carry file_path: null to represent a missing path; a non-string is still rejected', () => {
  const v = { id: 'ts-abcdef', lang: 'ts', event: 'PreToolUse', tool: 'Edit', input: { file_path: null }, expected: { kind: 'pass' }, source: 'adversarial' };
  assert.deepEqual(validateVector(v), []);
  assert.ok(validateVector({ ...v, input: { file_path: 3 } }).some((e) => /file_path/.test(e)));
  assert.equal(normalisePayload('Edit', { file_path: null }), '');
});

test('edit-tool vectors may carry a shape (append, insert, replace) that is part of the payload key', () => {
  assert.equal(normalisePayload('Edit', { file_path: 'a.ts', shape: 'append' }), 'a.ts|shape=append');
  assert.equal(normalisePayload('Edit', { file_path: 'a.ts' }), 'a.ts');
  assert.notEqual(vectorId('ts', 'PreToolUse', 'Edit', { file_path: 'a.ts', shape: 'append' }, true), vectorId('ts', 'PreToolUse', 'Edit', { file_path: 'a.ts' }, true));
  const v = { id: 'ts-abcdef', lang: 'ts', event: 'PreToolUse', tool: 'Edit', input: { file_path: 'a.ts', shape: 'insert' }, fixture: { exists: ['a.ts'] }, expected: { kind: 'ask', guard: 'test' }, source: 'adversarial' };
  assert.deepEqual(validateVector(v), []);
  assert.ok(validateVector({ ...v, input: { file_path: 'a.ts', shape: 'weird' } }).some((e) => /shape/.test(e)));
  assert.ok(validateVector({ ...v, tool: 'Bash', input: { command: 'ls', shape: 'append' } }).some((e) => /shape/.test(e)));
});
