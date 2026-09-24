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
    // every edit-tool use yields a PreToolUse row and a PostToolUse twin; the checks below look at the PreToolUse rows
    assert.deepEqual(cmds.filter((_, i) => rows[i].event === 'PreToolUse'), ['npx vitest run src/a.test.ts', 'src/new.ts', 'src/new.ts', 'src/new.ts', '~/private/notes.ts', '/Volumes/Other/drive/y.ts']);
    assert.equal(rows.filter((v) => v.tool === 'Write').length, 4);
    assert.equal(rows.filter((v) => v.event === 'PostToolUse').length, 5);
    const [w1, e1, w2, e2, e3] = rows.filter((v) => v.tool !== 'Bash' && v.event === 'PreToolUse');
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
    assert.equal(rows[0].id, vectorId('ts', 'PreToolUse', 'Bash', { command: 'npx vitest run src/a.test.ts' }));
    assert.deepEqual(r.dropped, { secret: 1, 'sensitive-path': 1, 'escaping-path': 0, personal: 0, shadowed: 0, rebuilt: 0 });
    assert.equal(r.added, 11);
    assert.deepEqual(r.byLang, { ts: 11 });
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

// --- Fix round 2 -------------------------------------------------------

test('F1: a cwd that is a home directory itself never leaks the username via note', () => {
  const from = makeDataDir(); const out = makeDataDir();
  const dir = path.join(from.dir, '-w-app'); fs.mkdirSync(dir);
  const mk = (cwd, command) => ({
    type: 'assistant', cwd, timestamp: '2026-08-29T10:00:00.000Z',
    message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command } }] },
  });
  fs.writeFileSync(
    path.join(dir, 's1.jsonl'),
    [mk('/Users/alice', 'echo one'), mk('/home/bob', 'echo two')].map((r) => JSON.stringify(r)).join('\n') + '\n',
  );
  try {
    mine({ from: from.dir, out: out.dir, log: () => {} });
    const rows = readJsonl(path.join(out.dir, 'none.jsonl'));
    assert.equal(rows.length, 2);
    assert.ok(rows.every((v) => v.note.startsWith('home ')), JSON.stringify(rows.map((v) => v.note)));
    assert.ok(!JSON.stringify(rows).includes('alice'));
    assert.ok(!JSON.stringify(rows).includes('bob'));
  } finally { from.cleanup(); out.cleanup(); }
});

test('F2: a relative file_path that escapes upward is dropped as escaping-path; one that normalizes safely is kept', () => {
  const proj = makeProject({ files: { 'package.json': '{}' } });
  const from = makeDataDir(); const out = makeDataDir();
  try {
    const dir = path.join(from.dir, '-v-app'); fs.mkdirSync(dir);
    const mk = (file_path) => ({
      type: 'assistant', cwd: proj.dir, timestamp: '2026-08-29T10:00:00.000Z',
      message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path, old_string: 'a', new_string: 'b' } }] },
    });
    fs.writeFileSync(
      path.join(dir, 's1.jsonl'),
      [mk('../../etc/passwd'), mk('src/../a.ts')].map((r) => JSON.stringify(r)).join('\n') + '\n',
    );
    const r = mine({ from: from.dir, out: out.dir, log: () => {} });
    const rows = readJsonl(path.join(out.dir, 'ts.jsonl')).filter((v) => v.event === 'PreToolUse');   // the PostToolUse twin mirrors the kept row
    assert.equal(rows.length, 1);
    assert.equal(rows[0].input.file_path, 'a.ts');
    assert.equal(r.dropped['escaping-path'], 1);
    assert.ok(rows.every((v) => !JSON.stringify(v).includes('..')));
  } finally { proj.cleanup(); from.cleanup(); out.cleanup(); }
});

// --- Fix round 1 (E4) -------------------------------------------------

// --- Fix round 3 --------------------------------------------------------

test('mine drops personal-word vectors using a wordsFile, and counts them (never the real sibling path in tests)', () => {
  const proj = makeProject({ files: { 'package.json': '{}' } });
  const from = makeDataDir(); const out = makeDataDir(); const wordsDir = makeDataDir();
  try {
    const dir = path.join(from.dir, '-p-app'); fs.mkdirSync(dir);
    const mk = (command) => ({
      type: 'assistant', cwd: proj.dir, timestamp: '2026-08-29T10:00:00.000Z',
      message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command } }] },
    });
    fs.writeFileSync(
      path.join(dir, 's1.jsonl'),
      [mk('echo Alice asked'), mk('echo hi there')].map((r) => JSON.stringify(r)).join('\n') + '\n',
    );
    const wordsFile = path.join(wordsDir.dir, 'redact.local.json');
    fs.writeFileSync(wordsFile, JSON.stringify({ words: ['Alice'] }));
    const log = [];
    const r = mine({ from: from.dir, out: out.dir, wordsFile, log: (s) => log.push(s) });
    const rows = readJsonl(path.join(out.dir, 'ts.jsonl'));
    const cmds = rows.map((v) => v.input.command);
    assert.ok(!cmds.includes('echo Alice asked'), JSON.stringify(cmds));
    assert.ok(cmds.includes('echo hi there'), JSON.stringify(cmds));
    assert.equal(r.dropped.personal, 1);
    assert.ok(log.some((s) => /personal=1/.test(s)), log.join('\n'));
  } finally { proj.cleanup(); from.cleanup(); out.cleanup(); wordsDir.cleanup(); }
});

test('mine works with no wordsFile at all (missing file → no personal drops)', () => {
  const proj = makeProject({ files: { 'package.json': '{}' } });
  const from = makeDataDir(); const out = makeDataDir(); const wordsDir = makeDataDir();
  try {
    const dir = path.join(from.dir, '-q-app'); fs.mkdirSync(dir);
    const rec = {
      type: 'assistant', cwd: proj.dir, timestamp: '2026-08-29T10:00:00.000Z',
      message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'echo hi' } }] },
    };
    fs.writeFileSync(path.join(dir, 's1.jsonl'), JSON.stringify(rec) + '\n');
    const r = mine({ from: from.dir, out: out.dir, wordsFile: path.join(wordsDir.dir, 'does-not-exist.json'), log: () => {} });
    assert.equal(r.dropped.personal, 0);
    assert.equal(readJsonl(path.join(out.dir, 'ts.jsonl')).length, 1);
  } finally { proj.cleanup(); from.cleanup(); out.cleanup(); wordsDir.cleanup(); }
});

test('B1: a mined vector whose id already exists in the sibling adversarial corpus is shadowed, not re-mined', () => {
  const proj = makeProject({ files: { 'package.json': '{}' } });
  const from = makeDataDir(); const root = makeDataDir();
  const out = path.join(root.dir, 'mined');
  const adversarialDir = path.join(root.dir, 'adversarial');
  fs.mkdirSync(out, { recursive: true });
  fs.mkdirSync(adversarialDir, { recursive: true });
  try {
    const dir = path.join(from.dir, '-shadow-app'); fs.mkdirSync(dir);
    const rec = {
      type: 'assistant', cwd: proj.dir, timestamp: '2026-08-29T10:00:00.000Z',
      message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npx vitest run src/a.test.ts' } }] },
    };
    fs.writeFileSync(path.join(dir, 's1.jsonl'), JSON.stringify(rec) + '\n');
    const shadowId = vectorId('ts', 'PreToolUse', 'Bash', { command: 'npx vitest run src/a.test.ts' });
    fs.writeFileSync(
      path.join(adversarialDir, 'x.jsonl'),
      JSON.stringify({ id: shadowId, lang: 'ts', event: 'PreToolUse', tool: 'Bash', input: { command: 'npx vitest run src/a.test.ts' }, expected: { kind: 'pass' }, source: 'adversarial', note: 'shadow' }) + '\n',
    );
    const log = [];
    const r = mine({ from: from.dir, out, log: (s) => log.push(s) });
    assert.equal(r.added, 0);
    assert.equal(r.dropped.shadowed, 1);
    assert.equal(fs.existsSync(path.join(out, 'ts.jsonl')), false);   // nothing left to write for this lang
    assert.ok(log.some((s) => /shadowed=1/.test(s)), log.join('\n'));
  } finally { proj.cleanup(); from.cleanup(); root.cleanup(); }
});

// --- Final wave ----------------------------------------------------------

test('item 2: --rebuild re-processes existing corpus rows through tightened redaction before merging fresh vectors', () => {
  const from = makeDataDir(); const out = makeDataDir(); const wordsDir = makeDataDir();
  try {
    const dir = path.join(from.dir, '-r-app'); fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 's1.jsonl'), '');   // no fresh vectors this run

    const rowA = { id: 'ts-aaaaaa', lang: 'ts', event: 'PreToolUse', tool: 'Bash', input: { command: 'echo session_01AbCdEfGhIjKlMnOpQrStUv' }, expected: { kind: 'pass' }, source: 'mined', note: 'app 2026-08' };
    const rowB = { id: 'ts-bbbbbb', lang: 'ts', event: 'PreToolUse', tool: 'Bash', input: { command: 'echo Alice was here' }, expected: { kind: 'pass' }, source: 'mined', note: 'app 2026-08' };
    fs.writeFileSync(path.join(out.dir, 'ts.jsonl'), [rowA, rowB].map((r) => JSON.stringify(r)).join('\n') + '\n');

    const wordsFile = path.join(wordsDir.dir, 'redact.local.json');
    fs.writeFileSync(wordsFile, JSON.stringify({ words: ['Alice'] }));

    const log = [];
    mine({ from: from.dir, out: out.dir, wordsFile, rebuild: true, log: (s) => log.push(s) });

    const rows = readJsonl(path.join(out.dir, 'ts.jsonl'));
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0].id, 'ts-aaaaaa');
    assert.equal(rows[0].input.command, 'echo session_00000000000000000000000000');
    assert.deepEqual(rows[0].expected, { kind: 'pass' });
    assert.equal(rows[0].id, vectorId('ts', 'PreToolUse', 'Bash', { command: 'echo session_00000000000000000000000000' }));
    assert.ok(log.some((s) => /rebuilt: 1 changed, 1 removed/.test(s)), log.join('\n'));
  } finally { from.cleanup(); out.cleanup(); wordsDir.cleanup(); }
});

test('item 2: --rebuild collapses two rows that redact to the same id, keeping the first', () => {
  const from = makeDataDir(); const out = makeDataDir();
  try {
    const dir = path.join(from.dir, '-c-app'); fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 's1.jsonl'), '');

    const rowA = { id: 'ts-cccccc', lang: 'ts', event: 'PreToolUse', tool: 'Bash', input: { command: 'echo session_01AbCdEfGhIjKlMnOpQrStUv one' }, expected: { kind: 'pass' }, source: 'mined', note: 'first' };
    const rowB = { id: 'ts-dddddd', lang: 'ts', event: 'PreToolUse', tool: 'Bash', input: { command: 'echo session_02ZzYyXxWwVvUuTtSsRrQqPpOo one' }, expected: { kind: 'ask' }, source: 'mined', note: 'second' };
    fs.writeFileSync(path.join(out.dir, 'ts.jsonl'), [rowA, rowB].map((r) => JSON.stringify(r)).join('\n') + '\n');

    const log = [];
    mine({ from: from.dir, out: out.dir, rebuild: true, log: (s) => log.push(s) });

    const rows = readJsonl(path.join(out.dir, 'ts.jsonl'));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].note, 'first');   // first row wins the collapse
    // item 3: the discarded (collapsed) row counts under "removed", not "changed" — rowA's own
    // redaction is the only real rewrite; rowB's collapse is a removal, not a second change.
    assert.ok(log.some((s) => /rebuilt: 1 changed, 1 removed/.test(s)), log.join('\n'));
  } finally { from.cleanup(); out.cleanup(); }
});

test('item 1: --rebuild re-redacts fixture.exists entries, not just the payload', () => {
  const from = makeDataDir(); const out = makeDataDir();
  try {
    const dir = path.join(from.dir, '-i-app'); fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 's1.jsonl'), '');   // no fresh vectors this run

    const input = { file_path: 'src/x.ts' };
    const id = vectorId('ts', 'PreToolUse', 'Edit', input, true);
    const row = { id, lang: 'ts', event: 'PreToolUse', tool: 'Edit', input, fixture: { exists: ['-Users-bob/x.ts'] }, expected: { kind: 'pass' }, source: 'mined', note: 'app 2026-08' };
    fs.writeFileSync(path.join(out.dir, 'ts.jsonl'), JSON.stringify(row) + '\n');

    const log = [];
    mine({ from: from.dir, out: out.dir, rebuild: true, log: (s) => log.push(s) });

    const rows = readJsonl(path.join(out.dir, 'ts.jsonl'));
    assert.equal(rows.length, 2);   // the rewritten row plus its back-filled PostToolUse twin
    assert.deepEqual(rows[0].fixture, { exists: ['-Users-~/x.ts'] });
    assert.deepEqual(rows[0].expected, { kind: 'pass' });
    assert.equal(rows[0].id, id);   // the id hashes only the fixture flag, not its content
    assert.deepEqual(rows[1].fixture, rows[0].fixture); assert.equal(rows[1].event, 'PostToolUse');   // the twin carries the re-redacted fixture
    assert.ok(log.some((s) => /rebuilt: 1 changed, 0 removed/.test(s)), log.join('\n'));   // proves the row was rewritten, not skipped
  } finally { from.cleanup(); out.cleanup(); }
});

test('item 1: --rebuild drops the whole row when a fixture.exists entry redacts as a secret', () => {
  const from = makeDataDir(); const out = makeDataDir();
  try {
    const dir = path.join(from.dir, '-j-app'); fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 's1.jsonl'), '');

    const input = { file_path: 'src/y.ts' };
    const id = vectorId('ts', 'PreToolUse', 'Edit', input, true);
    const row = { id, lang: 'ts', event: 'PreToolUse', tool: 'Edit', input, fixture: { exists: ['.ssh/id_rsa'] }, expected: { kind: 'pass' }, source: 'mined', note: 'app 2026-08' };
    fs.writeFileSync(path.join(out.dir, 'ts.jsonl'), JSON.stringify(row) + '\n');

    const log = [];
    mine({ from: from.dir, out: out.dir, rebuild: true, log: (s) => log.push(s) });

    assert.equal(fs.existsSync(path.join(out.dir, 'ts.jsonl')), true);
    assert.equal(readJsonl(path.join(out.dir, 'ts.jsonl')).length, 0);
    assert.ok(log.some((s) => /rebuilt: 0 changed, 1 removed/.test(s)), log.join('\n'));
  } finally { from.cleanup(); out.cleanup(); }
});

test('item 4: --rebuild without --from is corpus-only — no transcript walk, no default-home fallback', () => {
  // Pin HOME to an empty dir: with the fix, --rebuild never consults it; if the skip ever
  // regresses this fails closed (a "transcripts directory not found" error) instead of
  // silently walking the real ~/.claude/projects.
  const safeHome = makeDataDir();
  const corpus = makeDataDir();
  try {
    fs.mkdirSync(path.join(corpus.dir, 'mined'), { recursive: true });
    const input = { command: 'echo session_01AbCdEfGhIjKlMnOpQrStUv one' };
    const id = vectorId('ts', 'PreToolUse', 'Bash', input);
    const row = { id, lang: 'ts', event: 'PreToolUse', tool: 'Bash', input, expected: { kind: 'pass' }, source: 'mined', note: 'x' };
    fs.writeFileSync(path.join(corpus.dir, 'mined', 'ts.jsonl'), JSON.stringify(row) + '\n');

    const env = { ...process.env, HOME: safeHome.dir };
    const p = spawnSync(process.execPath, [path.join(ROOT, 'evals', 'mine.mjs'), '--rebuild', '--out', path.join(corpus.dir, 'mined')], { encoding: 'utf8', env });

    assert.equal(p.status, 0, p.stderr);
    assert.ok(!/transcripts directory not found/.test(p.stderr), p.stderr);
    assert.match(p.stdout, /rebuilt: 1 changed, 0 removed/);
    assert.match(p.stdout, /mined 0 new vector\(s\)/);

    const rows = readJsonl(path.join(corpus.dir, 'mined', 'ts.jsonl'));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].input.command, 'echo session_00000000000000000000000000 one');
  } finally { safeHome.cleanup(); corpus.cleanup(); }
});

test('item 8: note falls back to "project" when the project directory name itself matches a personal word', () => {
  const from = makeDataDir(); const out = makeDataDir(); const wordsDir = makeDataDir();
  try {
    const dir = path.join(from.dir, '-alice-app'); fs.mkdirSync(dir);
    const rec = {
      type: 'assistant', cwd: '/Users/x/Alice-app', timestamp: '2026-08-29T10:00:00.000Z',
      message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'echo hi' } }] },
    };
    fs.writeFileSync(path.join(dir, 's1.jsonl'), JSON.stringify(rec) + '\n');
    const wordsFile = path.join(wordsDir.dir, 'redact.local.json');
    fs.writeFileSync(wordsFile, JSON.stringify({ words: ['Alice'] }));
    mine({ from: from.dir, out: out.dir, wordsFile, log: () => {} });
    const rows = readJsonl(path.join(out.dir, 'none.jsonl'));
    assert.equal(rows.length, 1);
    assert.ok(rows[0].note.startsWith('project '), rows[0].note);
    assert.ok(!JSON.stringify(rows).toLowerCase().includes('alice'));
  } finally { from.cleanup(); out.cleanup(); wordsDir.cleanup(); }
});

test('T3: each edit-tool use also yields a PostToolUse twin with the same input and fixture; --rebuild back-fills missing twins', () => {
  const proj = makeProject({ files: { 'package.json': '{}' } });
  const from = makeDataDir(); const out = makeDataDir();
  try {
    const dir = path.join(from.dir, '-x-app'); fs.mkdirSync(dir);
    const rec = (tool, input) => JSON.stringify({ type: 'assistant', cwd: proj.dir, timestamp: '2026-08-01T00:00:00Z', message: { content: [{ type: 'tool_use', name: tool, input }] } });
    fs.writeFileSync(path.join(dir, 's.jsonl'), [rec('Edit', { file_path: path.join(proj.dir, 'src/a.ts') }), rec('Bash', { command: 'ls' })].join('\n') + '\n');
    mine({ from: from.dir, out: out.dir, log: () => {} });
    let rows = readJsonl(path.join(out.dir, 'ts.jsonl'));
    assert.deepEqual(rows.map((v) => `${v.event} ${v.tool}`), ['PreToolUse Edit', 'PostToolUse Edit', 'PreToolUse Bash']);
    assert.deepEqual(rows[1].input, rows[0].input); assert.deepEqual(rows[1].fixture, rows[0].fixture);
    assert.equal(rows[1].id, vectorId('ts', 'PostToolUse', 'Edit', rows[0].input, true));
    assert.equal(rows[1].expected, null);
    fs.writeFileSync(path.join(out.dir, 'ts.jsonl'), rows.filter((v) => v.event !== 'PostToolUse').map((v) => JSON.stringify(v)).join('\n') + '\n');
    const r = mine({ out: out.dir, rebuild: true, log: () => {} });
    rows = readJsonl(path.join(out.dir, 'ts.jsonl'));
    assert.equal(rows.filter((v) => v.event === 'PostToolUse').length, 1, 'rebuild adds the missing twin');
    assert.equal(r.paired, 1);
    assert.equal(mine({ out: out.dir, rebuild: true, log: () => {} }).paired, 0, 'idempotent');
  } finally { proj.cleanup(); from.cleanup(); out.cleanup(); }
});

test('shape: edit results are classified as append, insert, or replace from the paired tool result; shaped rows replace shapeless ones', () => {
  const proj = makeProject({ files: { 'package.json': '{}' } });
  const from = makeDataDir(); const out = makeDataDir();
  try {
    const dir = path.join(from.dir, '-x-app'); fs.mkdirSync(dir);
    let n = 0;
    const pair = (tool, input, result) => {
      const id = `toolu_${++n}`;
      return [
        JSON.stringify({ type: 'assistant', cwd: proj.dir, timestamp: '2026-08-01T00:00:00Z', message: { content: [{ type: 'tool_use', id, name: tool, input }] } }),
        JSON.stringify({ type: 'user', cwd: proj.dir, timestamp: '2026-08-01T00:00:01Z', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] }, toolUseResult: result }),
      ];
    };
    const fp = path.join(proj.dir, 'src/a.test.ts');
    const lines = [
      ...pair('Edit', { file_path: fp, old_string: 'a', new_string: 'a\nb' }, { filePath: fp, oldString: 'a', newString: 'a\nb', originalFile: 'x\na\n', replaceAll: false }),
      ...pair('Edit', { file_path: fp, old_string: 'x', new_string: 'x\nq' }, { filePath: fp, oldString: 'x', newString: 'x\nq', originalFile: 'x\na\n', replaceAll: false }),
      ...pair('Edit', { file_path: fp, old_string: 'a', new_string: 'c' }, { filePath: fp, oldString: 'a', newString: 'c', originalFile: 'x\na\n', replaceAll: false }),
      ...pair('Write', { file_path: fp, content: 'x\na\nz\n' }, { type: 'update', filePath: fp, content: 'x\na\nz\n', originalFile: 'x\na\n' }),
      ...pair('Write', { file_path: path.join(proj.dir, 'src/new.test.ts'), content: 'n' }, { type: 'create', filePath: fp, content: 'n', originalFile: null }),
      ...pair('Edit', { file_path: path.join(proj.dir, 'src/b.test.ts'), old_string: 'a', new_string: 'b' }, undefined),   // no result: shape unknown
    ];
    fs.writeFileSync(path.join(dir, 's.jsonl'), lines.filter(Boolean).join('\n') + '\n');
    // a shapeless row for src/a.test.ts from an earlier mine, with its label
    const stale = { id: vectorId('ts', 'PreToolUse', 'Edit', { file_path: 'src/a.test.ts' }, true), lang: 'ts', event: 'PreToolUse', tool: 'Edit', input: { file_path: 'src/a.test.ts' }, fixture: { exists: ['src/a.test.ts'] }, expected: { kind: 'ask', guard: 'test' }, source: 'mined', note: 'app 2026-07' };
    fs.writeFileSync(path.join(out.dir, 'ts.jsonl'), JSON.stringify(stale) + '\n');
    const r = mine({ from: from.dir, out: out.dir, log: () => {} });
    const rows = readJsonl(path.join(out.dir, 'ts.jsonl')).filter((v) => v.event === 'PreToolUse');
    assert.deepEqual(rows.map((v) => `${v.tool} ${v.input.file_path} ${v.input.shape ?? '-'}`), [
      'Edit src/a.test.ts append', 'Edit src/a.test.ts insert', 'Edit src/a.test.ts replace', 'Write src/a.test.ts append', 'Write src/new.test.ts -', 'Edit src/b.test.ts -',
    ]);
    assert.ok(!rows.some((v) => v.id === stale.id), 'the shapeless row for the same file is replaced');
    assert.equal(r.upgraded, 1);   // the stale PreToolUse row; a twin would count as another row
  } finally { proj.cleanup(); from.cleanup(); out.cleanup(); }
});

test('shape: a whole test block inserted between blocks is insert-block; it supersedes a plain insert row for the same edit', () => {
  const proj = makeProject({ files: { 'package.json': '{}' } });
  const from = makeDataDir(); const out = makeDataDir();
  try {
    const dir = path.join(from.dir, '-x-app'); fs.mkdirSync(dir);
    const fp = path.join(proj.dir, 'src/a.test.ts');
    const orig = 'test("a", () => {});\n\ntest("z", () => {});\n';
    const call = (id, input) => JSON.stringify({ type: 'assistant', cwd: proj.dir, timestamp: '2026-08-01T00:00:00Z', message: { content: [{ type: 'tool_use', id, name: 'Edit', input }] } });
    const result = (id, r) => JSON.stringify({ type: 'user', cwd: proj.dir, timestamp: '2026-08-01T00:00:01Z', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] }, toolUseResult: r });
    const edit = { oldString: 'test("a", () => {});', newString: 'test("a", () => {});\n\ntest("m", () => {});', originalFile: orig, replaceAll: false, filePath: fp };
    fs.writeFileSync(path.join(dir, 's.jsonl'), [call('t1', { file_path: fp, old_string: edit.oldString, new_string: edit.newString }), result('t1', edit)].join('\n') + '\n');
    const stale = { id: vectorId('ts', 'PreToolUse', 'Edit', { file_path: 'src/a.test.ts', shape: 'insert' }, true), lang: 'ts', event: 'PreToolUse', tool: 'Edit', input: { file_path: 'src/a.test.ts', shape: 'insert' }, fixture: { exists: ['src/a.test.ts'] }, expected: { kind: 'ask', guard: 'test' }, source: 'mined', note: 'app 2026-07' };
    fs.writeFileSync(path.join(out.dir, 'ts.jsonl'), JSON.stringify(stale) + '\n');
    const r = mine({ from: from.dir, out: out.dir, log: () => {} });
    const rows = readJsonl(path.join(out.dir, 'ts.jsonl')).filter((v) => v.event === 'PreToolUse');
    assert.deepEqual(rows.map((v) => v.input.shape), ['insert-block']);
    assert.equal(r.upgraded, 1);
  } finally { proj.cleanup(); from.cleanup(); out.cleanup(); }
});

test('shape: a php method added ahead of the class-closing brace is insert-block and supersedes a replace row; a split anchor around plain lines is insert', () => {
  const proj = makeProject({ files: { 'composer.json': '{}' } });
  const from = makeDataDir(); const out = makeDataDir();
  try {
    const dir = path.join(from.dir, '-x-app'); fs.mkdirSync(dir);
    const fp = path.join(proj.dir, 'tests/ATest.php');
    const orig = '<?php\n\nfinal class ATest extends TestCase\n{\n    public function testA(): void\n    {\n    }\n}\n';
    const call = (id, input) => JSON.stringify({ type: 'assistant', cwd: proj.dir, timestamp: '2026-09-01T00:00:00Z', message: { content: [{ type: 'tool_use', id, name: 'Edit', input }] } });
    const result = (id, r) => JSON.stringify({ type: 'user', cwd: proj.dir, timestamp: '2026-09-01T00:00:01Z', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] }, toolUseResult: r });
    const block = { oldString: '    }\n}', newString: '    }\n\n    public function testM(): void\n    {\n    }\n}', originalFile: orig, replaceAll: false, filePath: fp };
    const plain = { oldString: '<?php\n\nfinal', newString: '<?php\n\n// note\nfinal', originalFile: orig, replaceAll: false, filePath: fp };
    fs.writeFileSync(path.join(dir, 's.jsonl'), [
      call('t1', { file_path: fp, old_string: block.oldString, new_string: block.newString }), result('t1', block),
      call('t2', { file_path: fp, old_string: plain.oldString, new_string: plain.newString }), result('t2', plain),
    ].join('\n') + '\n');
    const stale = { id: vectorId('php', 'PreToolUse', 'Edit', { file_path: 'tests/ATest.php', shape: 'replace' }, true), lang: 'php', event: 'PreToolUse', tool: 'Edit', input: { file_path: 'tests/ATest.php', shape: 'replace' }, fixture: { exists: ['tests/ATest.php'] }, expected: { kind: 'ask', guard: 'test' }, source: 'mined', note: 'app 2026-08' };
    fs.writeFileSync(path.join(out.dir, 'php.jsonl'), JSON.stringify(stale) + '\n');
    const r = mine({ from: from.dir, out: out.dir, log: () => {} });
    const rows = readJsonl(path.join(out.dir, 'php.jsonl')).filter((v) => v.event === 'PreToolUse');
    assert.deepEqual(rows.map((v) => v.input.shape).sort(), ['insert', 'insert-block']);
    assert.equal(r.upgraded, 1);   // the replace row mined before split anchors were understood
  } finally { proj.cleanup(); from.cleanup(); out.cleanup(); }
});

test('shape: an Edit result recorded with originalFile null is still shaped from its two strings, and a shapeless row never sits beside a shaped sibling from the same walk', () => {
  const proj = makeProject({ files: { 'package.json': '{}' } });
  const from = makeDataDir(); const out = makeDataDir();
  try {
    const dir = path.join(from.dir, '-x-app'); fs.mkdirSync(dir);
    const fp = path.join(proj.dir, 'src/a.test.ts');
    let n = 0;
    const pair = (input, result) => {
      const id = `toolu_${++n}`;
      return [
        JSON.stringify({ type: 'assistant', cwd: proj.dir, timestamp: '2026-09-01T00:00:00Z', message: { content: [{ type: 'tool_use', id, name: 'Edit', input }] } }),
        result === undefined ? null : JSON.stringify({ type: 'user', cwd: proj.dir, timestamp: '2026-09-01T00:00:01Z', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] }, toolUseResult: result }),
      ];
    };
    const noOrig = (o, nw) => ({ filePath: fp, oldString: o, newString: nw, originalFile: null, replaceAll: false });
    const lines = [
      ...pair({ file_path: fp, old_string: 'a', new_string: 'b' }, noOrig('a', 'b')),                       // changed text: replace
      ...pair({ file_path: fp, old_string: 'a', new_string: 'a\nb' }, noOrig('a', 'a\nb')),                 // contained anchor: insert
      ...pair({ file_path: fp, old_string: '  }\n}', new_string: '  }\n\n  b\n}' }, noOrig('  }\n}', '  }\n\n  b\n}')),   // split anchor: insert
      ...pair({ file_path: fp, old_string: 'a', new_string: 'c' }, undefined),                              // no result at all: shapeless, and a shaped sibling exists
      ...pair({ file_path: path.join(proj.dir, 'src/b.test.ts'), old_string: 'a', new_string: 'c' }, undefined),   // no result and no sibling: stays shapeless
    ];
    fs.writeFileSync(path.join(dir, 's.jsonl'), lines.filter(Boolean).join('\n') + '\n');
    mine({ from: from.dir, out: out.dir, log: () => {} });
    const rows = readJsonl(path.join(out.dir, 'ts.jsonl')).filter((v) => v.event === 'PreToolUse');
    assert.deepEqual(rows.map((v) => `${v.input.file_path} ${v.input.shape ?? '-'}`).sort(), ['src/a.test.ts insert', 'src/a.test.ts replace', 'src/b.test.ts -']);
  } finally { proj.cleanup(); from.cleanup(); out.cleanup(); }
});
