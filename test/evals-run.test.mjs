import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runSuite, evaluateVector, makeLangProject, compare, sampleViaCli, fisherYates } from '../evals/run.mjs';
import { readJsonl } from '../evals/lib/corpus.mjs';
import { toJson } from '../evals/lib/report.mjs';
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

// --- Fix round 1 -----------------------------------------------------------

test('F1a: runSuite throws when the corpus directory does not exist', () => {
  assert.throws(() => runSuite({ corpusDir: '/nonexistent-corpus-dir', configsDir: CONFIGS, quiet: true }), /corpus directory not found/);
});

test('F1b: runSuite throws when no vectors are selected', () => {
  const c = copyFixture();
  try {
    assert.throws(() => runSuite({ corpusDir: c.dir, configsDir: CONFIGS, quiet: true, lang: 'zz' }), /no vectors selected/);
  } finally { c.cleanup(); }
});

test('fix round 2, item 1: runSuite throws when the --guard post-filter empties the results', () => {
  const c = copyFixture();
  try {
    assert.throws(() => runSuite({ corpusDir: c.dir, configsDir: CONFIGS, quiet: true, guard: 'nope' }), /no vectors selected after filters/);
  } finally { c.cleanup(); }
});

test('F1c: parseArgs rejects a flag missing its value, or one shaped like another flag', () => {
  const missing = spawnSync(process.execPath, [path.join(ROOT, 'evals', 'run.mjs'), '--corpus'], { encoding: 'utf8' });
  assert.equal(missing.status, 1); assert.match(missing.stderr, /--corpus/);

  const flagShaped = spawnSync(process.execPath, [path.join(ROOT, 'evals', 'run.mjs'), '--corpus', '--quiet'], { encoding: 'utf8' });
  assert.equal(flagShaped.status, 1); assert.match(flagShaped.stderr, /--corpus/);

  const lastToken = spawnSync(process.execPath, [path.join(ROOT, 'evals', 'run.mjs'), '--lang'], { encoding: 'utf8' });
  assert.equal(lastToken.status, 1); assert.match(lastToken.stderr, /--lang/);
});

test('F1: the CLI surfaces a runSuite error as "evals: <message>" and exits 1', () => {
  const p = spawnSync(process.execPath, [path.join(ROOT, 'evals', 'run.mjs'), '--corpus', '/nonexistent-corpus-dir', '--configs', CONFIGS, '--quiet'], { encoding: 'utf8' });
  assert.equal(p.status, 1);
  assert.match(p.stderr, /evals: corpus directory not found/);
});

test('F2: evaluateVector reports a guard crash as kind "crashed", not a real decision', () => {
  const proj = makeLangProject('ts', CONFIGS); const data = makeDataDir();
  try {
    const broken = { ...proj, config: { ...proj.config, commands: undefined } };
    const r = evaluateVector({ lang: 'ts', event: 'PreToolUse', tool: 'Bash', input: { command: 'git commit -m "x"' } }, broken, data.dir);
    assert.equal(r.kind, 'crashed');
    assert.ok(r.guard);
    assert.ok(r.reason);
  } finally { proj.cleanup(); data.cleanup(); }
});

test('F2: compare reports "crashed" regardless of expected', () => {
  assert.equal(compare({ expected: { kind: 'pass' } }, { kind: 'crashed' }), 'crashed');
  assert.equal(compare({ expected: null }, { kind: 'crashed' }), 'crashed');
});

test('F2: runSuite reports a crashed guard exec via an injected projectFactory, not a false decision, and never labels it on --update', () => {
  const data = makeDataDir();
  const corpusDir = path.join(data.dir, 'corpus');
  try {
    const crashVector = { id: 'ts-000099', lang: 'ts', event: 'PreToolUse', tool: 'Bash', input: { command: 'git status' }, expected: null, source: 'mined', note: 'forced crash: injected project has no config.commands' };
    fs.mkdirSync(path.join(corpusDir, 'mined'), { recursive: true });
    fs.writeFileSync(path.join(corpusDir, 'mined', 'crash.jsonl'), JSON.stringify(crashVector) + '\n');

    // deterministic crash independent of any guard implementation bug: a project whose config
    // is missing `commands` makes every Pre/PostToolUse guard that reads config.commands.* throw.
    const brokenFactory = (lang, configsDir) => {
      const proj = makeLangProject(lang, configsDir);
      return { ...proj, config: { ...proj.config, commands: undefined } };
    };

    const r = runSuite({ corpusDir, configsDir: CONFIGS, quiet: true, projectFactory: brokenFactory });
    assert.equal(r.exitCode, 1);
    assert.match(r.report, /crashed \(1\)/);
    const by = Object.fromEntries(r.results.map((x) => [x.vector.id, x.status]));
    assert.equal(by['ts-000099'], 'crashed');

    runSuite({ corpusDir, configsDir: CONFIGS, quiet: true, update: true, projectFactory: brokenFactory });
    const crashFile = readJsonl(path.join(corpusDir, 'mined', 'crash.jsonl'));
    assert.equal(crashFile.find((v) => v.id === 'ts-000099').expected, null);   // --update never labels a crashed vector
  } finally { data.cleanup(); }
});

test('minor 3: makeLangProject with no config for a lang throws and leaves no temp dir', () => {
  const tmpConfigs = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-harness-eval-configs-'));
  try {
    fs.copyFileSync(path.join(CONFIGS, 'ts.json'), path.join(tmpConfigs, 'ts.json'));
    const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('cc-harness-eval-go-'));
    assert.throws(() => makeLangProject('go', tmpConfigs), /no config for lang "go"/);
    const after = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('cc-harness-eval-go-'));
    assert.deepEqual(after, before);
  } finally { fs.rmSync(tmpConfigs, { recursive: true, force: true }); }
});

test('minor 3: makeLangProject cleans up its temp dir when the config is invalid', () => {
  const tmpConfigs = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-harness-eval-configs-'));
  try {
    fs.writeFileSync(path.join(tmpConfigs, 'ts.json'), JSON.stringify({ version: 2 }));   // unsupported version → invalid
    const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('cc-harness-eval-ts-'));
    assert.throws(() => makeLangProject('ts', tmpConfigs), /config ts: invalid/);
    const after = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('cc-harness-eval-ts-'));
    assert.deepEqual(after, before);
  } finally { fs.rmSync(tmpConfigs, { recursive: true, force: true }); }
});

test('minor 4: formatReport shows the first three lines of a mismatch reason, indented', () => {
  const c = copyFixture();
  try {
    const r = runSuite({ corpusDir: c.dir, configsDir: CONFIGS, quiet: true });
    const idx = r.report.indexOf('ts-000005');
    const chunk = r.report.slice(idx, idx + 500);
    const reasonLines = chunk.split('\n').filter((l) => l.trim().startsWith('reason:'));
    assert.equal(reasonLines.length, 3);
    for (const l of reasonLines) assert.match(l, /^      reason: /);
  } finally { c.cleanup(); }
});

test('minor 5: toJson results include the actual reason', () => {
  const c = copyFixture();
  try {
    const r = runSuite({ corpusDir: c.dir, configsDir: CONFIGS, quiet: true });
    const j = toJson(r.results, {});
    const row = j.results.find((x) => x.id === 'ts-000005');
    assert.ok(row.actual.reason && row.actual.reason.includes('commit guard rejected'));
  } finally { c.cleanup(); }
});

// --- Fix round 1 (E4) -------------------------------------------------

test('B2: a duplicate id where one copy is mined and the other adversarial is shadowed, not thrown', () => {
  const c = copyFixture();
  try {
    // ts-000010 already exists in adversarial/git.jsonl (see the fixture corpus); a mined
    // vector minted with the same id is shadowed rather than causing a duplicate-id error.
    const dup = { id: 'ts-000010', lang: 'ts', event: 'PreToolUse', tool: 'Bash', input: { command: 'git status' }, expected: { kind: 'pass' }, source: 'mined', note: 'dup of an adversarial id' };
    fs.writeFileSync(path.join(c.dir, 'mined', 'dup.jsonl'), JSON.stringify(dup) + '\n');
    const r = runSuite({ corpusDir: c.dir, configsDir: CONFIGS, quiet: true });
    assert.equal(r.shadowed, 1);
    assert.ok(!r.results.some((x) => x.vector.id === 'ts-000010' && x.vector.source === 'mined'));
    assert.ok(r.results.some((x) => x.vector.id === 'ts-000010' && x.vector.source === 'adversarial'));
    assert.match(r.report, /shadowed by adversarial: 1/);
    const j = toJson(r.results, { shadowed: r.shadowed });
    assert.equal(j.totals.shadowed, 1);
  } finally { c.cleanup(); }
});

test('B2: a duplicate id within the same source still throws', () => {
  const c = copyFixture();
  try {
    // ts-000003 already exists in mined/ts.jsonl; a second mined copy of the same id is a
    // real duplicate, not a cross-source shadow, and must still throw.
    const dup = { id: 'ts-000003', lang: 'ts', event: 'PreToolUse', tool: 'Edit', input: { file_path: 'src/other.test.ts' }, expected: { kind: 'ask', guard: 'test' }, source: 'mined', note: 'dup of a mined id' };
    fs.writeFileSync(path.join(c.dir, 'mined', 'dup.jsonl'), JSON.stringify(dup) + '\n');
    assert.throws(() => runSuite({ corpusDir: c.dir, configsDir: CONFIGS, quiet: true }), /duplicate vector id ts-000003/);
  } finally { c.cleanup(); }
});

test('--via cli --sample compares the stdout envelope with the in-process decision', () => {
  const c = copyFixture();
  try {
    const r = runSuite({ corpusDir: c.dir, configsDir: CONFIGS, quiet: true, viaCli: true, sample: 3, update: true });
    assert.match(r.report, /via cli: 3 checked, 0 envelope mismatches/);
    assert.equal(r.exitCode, 1);   // gap-closed fixture still fails; envelope is clean
  } finally { c.cleanup(); }
});

// --- Fix round 1 -------------------------------------------------------

test('F1: sampleViaCli scores a failed cli spawn as an envelope mismatch, not a pass', () => {
  const c = copyFixture();
  try {
    const r = runSuite({
      corpusDir: c.dir, configsDir: CONFIGS, quiet: true, update: true,
      viaCli: true, sample: 3, cliEnv: { NODE_OPTIONS: '--require /nonexistent' },
    });
    assert.equal(r.viaCli.mismatches.length, 3);
    const decisionKinds = ['pass', 'ask', 'deny', 'block'];
    for (const m of r.viaCli.mismatches) assert.ok(!decisionKinds.includes(m.viaCli), `unexpected decision-shaped viaCli: ${m.viaCli}`);
    assert.equal(r.exitCode, 1);
  } finally { c.cleanup(); }
});

test('F1 minor: sampleViaCli excludes crashed results from the sample pool', () => {
  const proj = makeLangProject('ts', CONFIGS); const data = makeDataDir();
  try {
    const goodVector = { id: 'ts-good1', lang: 'ts', event: 'PreToolUse', tool: 'Bash', input: { command: 'echo hi' } };
    const good = { vector: goodVector, actual: evaluateVector(goodVector, proj, data.dir), status: 'match' };
    // lang "nope" has no project; if the crashed entry were not excluded, sampling it would
    // throw trying to read project.dir off an undefined project.
    const crashedVector = { id: 'ts-crash1', lang: 'nope', event: 'PreToolUse', tool: 'Bash', input: { command: 'x' } };
    const crashed = { vector: crashedVector, actual: { kind: 'crashed' }, status: 'crashed' };
    const r = sampleViaCli([good, crashed], new Map([['ts', proj]]), { sample: 5, dataDir: data.dir });
    assert.equal(r.checked, 1);
    assert.ok(!r.mismatches.some((m) => m.id === 'ts-crash1'));
  } finally { proj.cleanup(); data.cleanup(); }
});

// --- Final wave ----------------------------------------------------------

test('item 3: makeLangProject builds a sibling cliDir with a real "exit 1" check wired into the stop guard', () => {
  const proj = makeLangProject('ts', CONFIGS);
  try {
    assert.ok(proj.cliDir);
    assert.notEqual(proj.cliDir, proj.dir);
    assert.ok(fs.existsSync(path.join(proj.cliDir, 'package.json')));   // marker mirrored
    const cliConfig = JSON.parse(fs.readFileSync(path.join(proj.cliDir, '.claude', 'harness.json'), 'utf8'));
    assert.equal(cliConfig.preset, 'custom');
    assert.deepEqual(cliConfig.checks, [{ name: 'eval-fail', cmd: 'exit 1', fast: true }]);
    assert.deepEqual(cliConfig.guards.stop.checks, ['eval-fail']);
    assert.deepEqual(cliConfig.project, proj.config.project);
    assert.deepEqual(cliConfig.commands, proj.config.commands);
    assert.deepEqual(cliConfig.guards.commit, proj.config.guards.commit);
  } finally { proj.cleanup(); }
});

test('item 3: sampleViaCli spawns the CLI against cliDir\'s real check runner — no env-var backdoor, PostToolUse blocks for real', () => {
  const proj = makeLangProject('ts', CONFIGS); const data = makeDataDir();
  try {
    const vector = { id: 'ts-000004', lang: 'ts', event: 'PostToolUse', tool: 'Edit', input: { file_path: 'src/a.ts' }, expected: { kind: 'block', guard: 'quality' }, source: 'mined', note: 'x' };
    // Lie about the in-process decision so any real CLI decision surfaces as a mismatch we can inspect.
    const lyingActual = { kind: 'pass', guard: null, reason: null };
    const r = sampleViaCli([{ vector, actual: lyingActual, status: 'mismatch' }], new Map([['ts', proj]]), { sample: 1, dataDir: data.dir });
    assert.equal(r.checked, 1);
    assert.equal(r.mismatches.length, 1);
    assert.equal(r.mismatches[0].viaCli, 'block');   // the real "exit 1" check armed the quality gate, no backdoor involved
  } finally { proj.cleanup(); data.cleanup(); }
});

test('item 4: fisherYates picks from the tail of a 200-item pool across 5 seeded LCG runs', () => {
  function lcg(seed) {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  }
  const items = Array.from({ length: 200 }, (_, i) => ({ id: i, adversarial: i >= 180 }));
  for (const seed of [1, 2, 3, 4, 5]) {
    const rng = lcg(seed);
    const sample = fisherYates(items, rng).slice(0, 50);
    assert.equal(sample.length, 50);
    assert.ok(sample.some((x) => x.adversarial), `seed ${seed} picked no adversarial item`);
  }
  // the source array is never mutated
  const original = [1, 2, 3, 4, 5];
  const copy = [...original];
  fisherYates(original, lcg(42));
  assert.deepEqual(original, copy);
});

test('item 5: a ~/ file_path resolves outside the project, not into a literal "~" directory inside it', () => {
  const proj = makeLangProject('ts', CONFIGS); const data = makeDataDir();
  try {
    const v = { lang: 'ts', event: 'PreToolUse', tool: 'Edit', input: { file_path: '~/.claude/CLAUDE.md' } };
    const a = evaluateVector(v, proj, data.dir);
    assert.equal(a.kind, 'pass');
    assert.ok(!fs.existsSync(path.join(proj.dir, '~')));
  } finally { proj.cleanup(); data.cleanup(); }
});

test('item 5: a ~/ fixture.exists entry is also never created as a literal "~" directory inside the project', () => {
  const proj = makeLangProject('ts', CONFIGS); const data = makeDataDir();
  try {
    const v = { lang: 'ts', event: 'PreToolUse', tool: 'Edit', input: { file_path: '~/.claude/CLAUDE.md' }, fixture: { exists: ['~/.claude/CLAUDE.md'] } };
    const a = evaluateVector(v, proj, data.dir);
    assert.equal(a.kind, 'pass');
    assert.ok(!fs.existsSync(path.join(proj.dir, '~')));
  } finally { proj.cleanup(); data.cleanup(); }
});

test('item 6: envelopeKind treats malformed CLI stdout as an envelope mismatch, not a thrown exception', () => {
  const c = copyFixture();
  const scriptDir = makeDataDir();
  const script = path.join(scriptDir.dir, 'garbage.cjs');
  fs.writeFileSync(script, 'process.stdout.write("nope"); process.exit(0);\n');
  try {
    const r = runSuite({
      corpusDir: c.dir, configsDir: CONFIGS, quiet: true, update: true,
      viaCli: true, sample: 3, cliEnv: { NODE_OPTIONS: `--require ${script}` },
    });
    assert.equal(r.viaCli.mismatches.length, 3);
    for (const m of r.viaCli.mismatches) assert.equal(m.viaCli, 'malformed');
    assert.equal(r.exitCode, 1);
  } finally { c.cleanup(); scriptDir.cleanup(); }
});

test('an armed quality gate blocks in-process even when the config has no checks, matching the --via cli project', () => {
  const p = makeLangProject('none', CONFIGS);
  const d = makeDataDir();
  try {
    const v = { id: 'none-abcdef', lang: 'none', event: 'PostToolUse', tool: 'Write', input: { file_path: 'src/a.test.ts' }, expected: null, source: 'mined' };
    const actual = evaluateVector(v, p, d.dir);
    assert.equal(actual.kind, 'block', JSON.stringify(actual));
    assert.equal(actual.guard, 'quality');
    assert.equal(evaluateVector({ ...v, input: { file_path: 'notes.md' } }, p, d.dir).kind, 'pass');   // not a source or test file: never armed
  } finally { p.cleanup(); d.cleanup(); }
});
