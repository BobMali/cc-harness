import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
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
    assert.deepEqual(cmds, ['npx vitest run src/a.test.ts', 'src/new.ts', 'src/new.ts', 'src/new.ts', '~/private/notes.ts', '/Volumes/Other/drive/y.ts']);
    assert.equal(rows.filter((v) => v.tool === 'Write').length, 2);
    const [w1, e1, w2, e2, e3] = rows.filter((v) => v.tool !== 'Bash');
    assert.equal(w1.fixture, undefined);                       // first Write: file did not exist
    assert.deepEqual(e1.fixture, { exists: ['src/new.ts'] }); // Edit implies existed
    assert.deepEqual(w2.fixture, { exists: ['src/new.ts'] }); // later Write: touched earlier
    assert.deepEqual(e2.fixture, { exists: ['~/private/notes.ts'] });               // outside cwd, under a home dir: scrubbed to ~
    assert.deepEqual(e3.fixture, { exists: ['/Volumes/Other/drive/y.ts'] });        // outside cwd, no home prefix: kept absolute as-is
    assert.ok(rows.every((v) => v.expected === null && v.source === 'mined' && v.lang === 'ts'));
    assert.ok(rows.every((v) => !JSON.stringify(v).includes(proj.dir)));
    assert.ok(rows.every((v) => !JSON.stringify(v).includes('carol')));
    assert.ok(rows.every((v) => !JSON.stringify(v).includes('..')));
    assert.ok(rows.every((v) => v.note === `${path.basename(proj.dir)} 2026-08`));
    assert.equal(rows[0].id, vectorId('ts', 'Bash', { command: 'npx vitest run src/a.test.ts' }));
    assert.deepEqual(r.dropped, { secret: 1, 'sensitive-path': 1 });
    assert.equal(r.added, 6);
    assert.deepEqual(r.byLang, { ts: 6 });
    assert.ok(log.some((s) => /longest/i.test(s)));

    // second run: nothing new, existing expectations preserved
    rows[0].expected = { kind: 'pass' };
    fs.writeFileSync(path.join(out.dir, 'ts.jsonl'), rows.map((v) => JSON.stringify(v)).join('\n') + '\n');
    const r2 = mine({ from: from.dir, out: out.dir, log: () => {} });
    assert.equal(r2.added, 0);
    assert.deepEqual(readJsonl(path.join(out.dir, 'ts.jsonl'))[0].expected, { kind: 'pass' });
  } finally { proj.cleanup(); from.cleanup(); out.cleanup(); }
});

// --- Fix round 1 -----------------------------------------------------------

test('C2: a record with no cwd never falls back to process.cwd() (output is chdir-invariant)', () => {
  const from = makeDataDir();
  const out1 = makeDataDir(); const out2 = makeDataDir();
  const cwdA = makeDataDir(); const cwdB = makeDataDir();
  const dir = path.join(from.dir, '-z-app'); fs.mkdirSync(dir);
  const rec = {
    type: 'assistant', timestamp: '2026-08-29T10:00:00.000Z',
    message: { role: 'assistant', content: [
      { type: 'tool_use', name: 'Edit', input: { file_path: '/some/absolute/path/file.ts', old_string: 'a', new_string: 'b' } },
    ] },
  }; // deliberately no "cwd" field
  fs.writeFileSync(path.join(dir, 's1.jsonl'), JSON.stringify(rec) + '\n');
  const prevCwd = process.cwd();
  try {
    process.chdir(cwdA.dir);
    mine({ from: from.dir, out: out1.dir, log: () => {} });
    process.chdir(cwdB.dir);
    mine({ from: from.dir, out: out2.dir, log: () => {} });
    const a = fs.readFileSync(path.join(out1.dir, 'none.jsonl'), 'utf8');
    const b = fs.readFileSync(path.join(out2.dir, 'none.jsonl'), 'utf8');
    assert.equal(a, b);                          // byte-identical regardless of invocation directory
    assert.ok(!a.includes('..'));
    assert.match(a, /"file_path":"\/some\/absolute\/path\/file\.ts"/);
  } finally {
    process.chdir(prevCwd);
    from.cleanup(); out1.cleanup(); out2.cleanup(); cwdA.cleanup(); cwdB.cleanup();
  }
});

test('I4: an unparsable timestamp falls back to an "unknown" month in note', () => {
  const proj = makeProject({ files: { 'package.json': '{}' } });
  const from = makeDataDir(); const out = makeDataDir();
  try {
    const dir = path.join(from.dir, '-y-app'); fs.mkdirSync(dir);
    const rec = { type: 'assistant', cwd: proj.dir, timestamp: 1758000000000, message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'echo hi' } }] } };
    fs.writeFileSync(path.join(dir, 's1.jsonl'), JSON.stringify(rec) + '\n');
    mine({ from: from.dir, out: out.dir, log: () => {} });
    const rows = readJsonl(path.join(out.dir, 'ts.jsonl'));
    assert.equal(rows.length, 1);
    assert.ok(rows[0].note.endsWith(' unknown'), rows[0].note);
  } finally { proj.cleanup(); from.cleanup(); out.cleanup(); }
});

test('M1: mine throws when the transcripts directory does not exist', () => {
  const out = makeDataDir();
  try {
    assert.throws(
      () => mine({ from: path.join(out.dir, 'does-not-exist'), out: out.dir, log: () => {} }),
      /transcripts directory not found:/,
    );
  } finally { out.cleanup(); }
});

test('M2: the CLI rejects --from/--out given without a value', () => {
  // Pin HOME to a directory with no .claude/projects so that IF this ever regresses
  // and falls through to the real default, it fails closed (throws "not found")
  // instead of actually mining the user's real transcripts.
  const safeHome = makeDataDir();
  const env = { ...process.env, HOME: safeHome.dir };
  try {
    const missingFrom = spawnSync(process.execPath, [path.join(ROOT, 'evals', 'mine.mjs'), '--from'], { encoding: 'utf8', env });
    assert.equal(missingFrom.status, 1);
    assert.match(missingFrom.stderr, /--from/);

    const flagShaped = spawnSync(process.execPath, [path.join(ROOT, 'evals', 'mine.mjs'), '--out', '--from', '/tmp'], { encoding: 'utf8', env });
    assert.equal(flagShaped.status, 1);
    assert.match(flagShaped.stderr, /--out/);
  } finally { safeHome.cleanup(); }
});
