import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectLang, extractToolUses, mine } from '../evals/mine.mjs';
import { readJsonl, vectorId } from '../evals/lib/corpus.mjs';
import { makeProject, makeDataDir } from './helpers/project.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TPL = path.join(ROOT, 'test', 'fixtures', 'evals', 'transcripts', '-Users-alice-projects-app', 's1.jsonl');

test('detectLang by marker file', () => {
  for (const [files, lang] of [[{ 'go.mod': '' }, 'go'], [{ 'composer.json': '{}' }, 'php'], [{ 'package.json': '{}' }, 'ts'], [{ 'Package.swift': '' }, 'swift'], [{ 'App.xcodeproj/project.pbxproj': '' }, 'swift'], [{ 'README.md': '' }, 'none']]) {
    const p = makeProject({ files });
    try { assert.equal(detectLang(p.dir), lang, JSON.stringify(files)); } finally { p.cleanup(); }
  }
  assert.equal(detectLang('/definitely/not/here'), 'none');
});

test('extractToolUses keeps only the four tools and trims payloads', () => {
  const rec = { type: 'assistant', message: { content: [
    { type: 'tool_use', name: 'Bash', input: { command: 'ls', description: 'x' } },
    { type: 'tool_use', name: 'Edit', input: { file_path: '/p/a.ts', old_string: 'a', new_string: 'b' } },
    { type: 'tool_use', name: 'Read', input: { file_path: '/p/a.ts' } },
    { type: 'text', text: 'hi' },
  ] } };
  assert.deepEqual(extractToolUses(rec), [{ tool: 'Bash', input: { command: 'ls' } }, { tool: 'Edit', input: { file_path: '/p/a.ts' } }]);
  assert.deepEqual(extractToolUses({ type: 'user', message: { content: 'x' } }), []);
});

test('mine: lang tag, fixture derivation, redaction, dedupe, merge with existing', () => {
  const proj = makeProject({ files: { 'package.json': '{}' } });
  const from = makeDataDir(); const out = makeDataDir();
  try {
    const dir = path.join(from.dir, '-x-app'); fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 's1.jsonl'), fs.readFileSync(TPL, 'utf8').split('CWD').join(proj.dir));
    const log = [];
    const r = mine({ from: from.dir, out: out.dir, log: (s) => log.push(s) });
    const rows = readJsonl(path.join(out.dir, 'ts.jsonl'));
    const cmds = rows.map((v) => v.input.command ?? v.input.file_path);
    assert.deepEqual(cmds, ['npx vitest run src/a.test.ts', 'src/new.ts', 'src/new.ts', 'src/new.ts']);
    assert.equal(rows.filter((v) => v.tool === 'Write').length, 2);
    const [w1, e1, w2] = rows.filter((v) => v.tool !== 'Bash');
    assert.equal(w1.fixture, undefined);                       // first Write: file did not exist
    assert.deepEqual(e1.fixture, { exists: ['src/new.ts'] }); // Edit implies existed
    assert.deepEqual(w2.fixture, { exists: ['src/new.ts'] }); // later Write: touched earlier
    assert.ok(rows.every((v) => v.expected === null && v.source === 'mined' && v.lang === 'ts'));
    assert.ok(rows.every((v) => !JSON.stringify(v).includes(proj.dir)));
    assert.ok(rows.every((v) => v.note === `${path.basename(proj.dir)} 2026-08`));
    assert.equal(rows[0].id, vectorId('ts', 'Bash', { command: 'npx vitest run src/a.test.ts' }));
    assert.deepEqual(r.dropped, { secret: 1, 'sensitive-path': 1 });
    assert.equal(r.added, 4);
    assert.deepEqual(r.byLang, { ts: 4 });
    assert.ok(log.some((s) => /longest/i.test(s)));

    // second run: nothing new, existing expectations preserved
    rows[0].expected = { kind: 'pass' };
    fs.writeFileSync(path.join(out.dir, 'ts.jsonl'), rows.map((v) => JSON.stringify(v)).join('\n') + '\n');
    const r2 = mine({ from: from.dir, out: out.dir, log: () => {} });
    assert.equal(r2.added, 0);
    assert.deepEqual(readJsonl(path.join(out.dir, 'ts.jsonl'))[0].expected, { kind: 'pass' });
  } finally { proj.cleanup(); from.cleanup(); out.cleanup(); }
});
