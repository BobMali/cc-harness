#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig } from '../plugins/cc-harness/lib/config.mjs';
import { evaluateGuards } from '../plugins/cc-harness/lib/cli.mjs';
import { pickDecision } from '../plugins/cc-harness/lib/hook-io.mjs';
import { pluginRoot } from '../plugins/cc-harness/lib/meta.mjs';
import { loadCorpus, writeJsonl, validateVector } from './lib/corpus.mjs';
import { formatReport, toJson } from './lib/report.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CORPUS = path.join(HERE, 'corpus');
const DEFAULT_CONFIGS = path.join(HERE, 'configs');
const MARKERS = { ts: 'package.json', go: 'go.mod', php: 'composer.json', swift: 'Package.swift', none: null };
const REGEX_FILE = '^(feat|fix|docs|test|refactor|build|ci|chore)(\\([a-z0-9-]+\\))?!?: [a-z](.{0,64}[^.])?$\n# types: feat fix docs test refactor build ci chore\n';
const STUB_EXEC = () => ({ status: 0, output: '' });
const FAIL_EXEC = () => ({ status: 1, output: 'eval: forced failure' });   // PostToolUse: makes "armed" observable as block
const BIN = path.join(pluginRoot(), 'bin', 'harness.mjs');

export function makeLangProject(lang, configsDir = DEFAULT_CONFIGS) {
  const configFile = path.join(configsDir, `${lang}.json`);
  if (!fs.existsSync(configFile)) throw new Error(`no config for lang "${lang}" in ${configsDir}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cc-harness-eval-${lang}-`));
  try {
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.copyFileSync(configFile, path.join(dir, '.claude', 'harness.json'));
    const loaded = loadConfig(dir);
    if (loaded.status !== 'ok') throw new Error(`config ${lang}: ${loaded.status} ${JSON.stringify(loaded.errors ?? [])}`);
    const marker = loaded.config.project.markerFile || MARKERS[lang];
    if (marker) writeEmpty(path.join(dir, marker));
    fs.mkdirSync(path.join(dir, 'githooks'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'githooks', 'conventional-regex.txt'), REGEX_FILE);
    for (const c of loaded.config.checks) if (c.ifExists) writeEmpty(path.join(dir, c.ifExists));   // so no check is skipped; exec is stubbed anyway

    // A sibling project for --via cli sampling: the real check runner (no stub, no env-var
    // backdoor) needs a check that actually fails so a sampled PostToolUse spawn observes the
    // same "armed" decision the in-process FAIL_EXEC stub produces. Building it costs a second
    // mkdtemp + config load per language, so it is built lazily on first access to `.cliDir`
    // (i.e. only when a run actually samples via --via cli) rather than for every project.
    let cliDirBuilt = null;
    const buildCliDir = () => {
      const cd = fs.mkdtempSync(path.join(os.tmpdir(), `cc-harness-eval-${lang}-cli-`));
      try {
        fs.mkdirSync(path.join(cd, '.claude'), { recursive: true });
        const cliConfig = {
          version: 1,
          preset: 'custom',
          project: loaded.config.project,
          commands: loaded.config.commands,
          checks: [{ name: 'eval-fail', cmd: 'exit 1', fast: true }],
          guards: { commit: loaded.config.guards.commit, stop: { checks: ['eval-fail'] } },
        };
        fs.writeFileSync(path.join(cd, '.claude', 'harness.json'), JSON.stringify(cliConfig, null, 2));
        const cliLoaded = loadConfig(cd);
        if (cliLoaded.status !== 'ok') throw new Error(`cli config ${lang}: ${cliLoaded.status} ${JSON.stringify(cliLoaded.errors ?? [])}`);
        if (marker) writeEmpty(path.join(cd, marker));
        fs.mkdirSync(path.join(cd, 'githooks'), { recursive: true });
        fs.writeFileSync(path.join(cd, 'githooks', 'conventional-regex.txt'), REGEX_FILE);
        return cd;
      } catch (e) {
        fs.rmSync(cd, { recursive: true, force: true });
        throw e;
      }
    };

    const project = {
      dir, lang, config: loaded.config,
      cleanup: () => { fs.rmSync(dir, { recursive: true, force: true }); if (cliDirBuilt) fs.rmSync(cliDirBuilt, { recursive: true, force: true }); },
    };
    Object.defineProperty(project, 'cliDir', {
      enumerable: true,
      get() { if (!cliDirBuilt) cliDirBuilt = buildCliDir(); return cliDirBuilt; },
    });
    return project;
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

function writeEmpty(abs) { fs.mkdirSync(path.dirname(abs), { recursive: true }); if (!fs.existsSync(abs)) { fs.writeFileSync(abs, ''); return true; } return false; }

function inside(root, abs) { const rel = path.relative(root, abs); return rel && !rel.startsWith('..') && !path.isAbsolute(rel); }

// A file_path of "~/…" names a real home-directory path, not a literal "~" entry inside the
// temp project; path.resolve(baseDir, '~/…') would create exactly that literal directory.
function resolveFilePath(baseDir, fp) {
  return fp.startsWith('~/') ? path.join(os.homedir(), fp.slice(2)) : path.resolve(baseDir, fp);
}

export function evaluateVector(vector, project, dataDir) {
  const created = [];
  for (const rel of vector.fixture?.exists ?? []) {
    const abs = resolveFilePath(project.dir, rel);
    if (!inside(project.dir, abs)) continue;
    if (writeEmpty(abs)) created.push(abs);
  }
  try {
    const toolInput = vector.tool === 'Bash'
      ? { command: vector.input.command }
      : { file_path: resolveFilePath(project.dir, vector.input.file_path) };
    const input = { hook_event_name: vector.event, tool_name: vector.tool, tool_input: toolInput, session_id: 'eval', cwd: project.dir };
    const ctx = { event: vector.event, input, config: project.config, projectDir: project.dir, dataDir, pluginRoot: pluginRoot(), exec: vector.event === 'PostToolUse' ? FAIL_EXEC : STUB_EXEC, fs, now: () => Date.now() };
    const crashed = [];
    const results = evaluateGuards(vector.event, ctx, { onError: (g, e) => crashed.push({ guard: g.name, message: e.message }) });
    if (crashed.length) return { kind: 'crashed', guard: crashed[0].guard, reason: crashed[0].message };
    const d = pickDecision(results.map((r) => r.decision));
    if (!d) return { kind: 'pass', guard: null, reason: null };
    const guard = results.find((r) => r.decision === d)?.guard ?? null;
    return { kind: d.kind, guard, reason: d.reason ?? null };
  } finally {
    for (const abs of created) fs.rmSync(abs, { force: true });
  }
}

export function compare(vector, actual) {
  if (actual.kind === 'crashed') return 'crashed';
  const e = vector.expected;
  if (!e) return 'unlabelled';
  const same = e.kind === actual.kind && (!e.guard || e.guard === actual.guard);
  if (e.known_gap) return same ? 'gap-closed' : 'known-gap';
  return same ? 'match' : 'mismatch';
}

function envelopeKind(stdout) {
  const s = stdout.trim();
  if (!s) return 'pass';
  let j;
  try { j = JSON.parse(s); } catch { return 'malformed'; }
  if (j.hookSpecificOutput?.permissionDecision) return j.hookSpecificOutput.permissionDecision;
  if (j.decision === 'block') return 'block';
  return 'pass';
}

// Fisher-Yates over a copy: sort(() => rng() - 0.5) is not a uniform shuffle (some engines and
// rng sequences barely reorder the array), which could leave a small sample missing an entire
// class of vectors clustered at one end of the corpus.
export function fisherYates(arr, rng) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function sampleViaCli(results, projects, { sample, dataDir, rng = Math.random, cliEnv = {} }) {
  // A crashed in-process result has no real decision to compare against; sampling it would
  // compare the CLI's envelope to a stub, not a decision, so it never enters the pool.
  const pool = fisherYates([...results].filter((r) => r.status !== 'crashed'), rng).slice(0, sample);
  const mismatches = [];
  for (const r of pool) {
    const v = r.vector; const project = projects.get(v.lang);
    const cliDir = project.cliDir;
    const created = [];
    for (const rel of v.fixture?.exists ?? []) { const abs = resolveFilePath(cliDir, rel); if (inside(cliDir, abs) && writeEmpty(abs)) created.push(abs); }
    try {
      const toolInput = v.tool === 'Bash' ? { command: v.input.command } : { file_path: resolveFilePath(cliDir, v.input.file_path) };
      const input = JSON.stringify({ hook_event_name: v.event, tool_name: v.tool, tool_input: toolInput, session_id: 'eval-cli', cwd: cliDir });
      const p = spawnSync(process.execPath, [BIN, 'hook', v.event], { input, encoding: 'utf8', timeout: 30_000, env: { ...process.env, CLAUDE_PROJECT_DIR: cliDir, CLAUDE_PLUGIN_DATA: dataDir, ...cliEnv } });
      if (p.error || p.status !== 0) { mismatches.push({ id: v.id, inProcess: r.actual.kind, viaCli: p.error?.code ?? `exit ${p.status}` }); continue; }
      const viaCli = envelopeKind(p.stdout);
      if (viaCli !== r.actual.kind) mismatches.push({ id: v.id, inProcess: r.actual.kind, viaCli });
    } finally { for (const abs of created) fs.rmSync(abs, { force: true }); }
  }
  return { checked: pool.length, mismatches };
}

export function runSuite(opts = {}) {
  const t0 = Date.now();
  const corpusDir = path.resolve(opts.corpusDir ?? DEFAULT_CORPUS);
  const configsDir = path.resolve(opts.configsDir ?? DEFAULT_CONFIGS);
  if (!fs.existsSync(corpusDir)) throw new Error(`corpus directory not found: ${corpusDir}`);
  const { vectors: rawVectors, byFile } = loadCorpus(corpusDir);
  // A duplicate id where one copy is mined and the other adversarial is not an error: the
  // adversarial corpus is hand-labelled and wins, the mined copy is dropped ("shadowed").
  // A duplicate id within the same source is still a real error and throws.
  const byId = new Map();
  for (const v of rawVectors) { if (!byId.has(v.id)) byId.set(v.id, []); byId.get(v.id).push(v); }
  const shadowed = [];
  const vectors = [];
  for (const v of rawVectors) {
    const group = byId.get(v.id);
    if (group.length === 1) { vectors.push(v); continue; }
    if (group.length > 2 || group[0].source === group[1].source) {
      throw new Error(`duplicate vector id ${v.id} in ${group[0].file} and ${group[1].file}`);
    }
    const adv = group.find((g) => g.source === 'adversarial');
    if (v === adv) vectors.push(v); else shadowed.push({ id: v.id, file: v.file });
  }
  const langs = opts.lang ? new Set(String(opts.lang).split(',')) : null;
  const selected = vectors.filter((v) => (!langs || langs.has(v.lang)) && (!opts.source || v.source === opts.source));
  if (selected.length === 0) {
    const filters = JSON.stringify({ lang: opts.lang ?? null, source: opts.source ?? null, guard: opts.guard ?? null });
    throw new Error(`no vectors selected (corpus ${corpusDir}, filters ${filters})`);
  }
  for (const v of selected) { const errs = validateVector(v); if (errs.length) throw new Error(`${v.file}: ${v.id}: ${errs.join('; ')}`); }
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-harness-eval-data-'));
  const projectFactory = opts.projectFactory ?? makeLangProject;
  const projects = new Map();
  const results = [];
  let viaCli = null;
  try {
    for (const v of selected) {
      if (!projects.has(v.lang)) projects.set(v.lang, projectFactory(v.lang, configsDir));
      const actual = evaluateVector(v, projects.get(v.lang), dataDir);
      if (opts.guard && actual.guard !== opts.guard && !(v.expected?.guard === opts.guard)) continue;
      results.push({ vector: v, actual, status: compare(v, actual) });
    }
    // Projects stay alive (inside this try, before cleanup below) so the sampled CLI spawns
    // can reuse the same temp project dirs the in-process decisions were computed against.
    if (opts.viaCli && results.length > 0) viaCli = sampleViaCli(results, projects, { sample: opts.sample ?? 100, dataDir, cliEnv: opts.cliEnv });
  } finally {
    for (const p of projects.values()) p.cleanup();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  if (results.length === 0) {
    const filters = JSON.stringify({ lang: opts.lang ?? null, source: opts.source ?? null, guard: opts.guard ?? null });
    throw new Error(`no vectors selected after filters (corpus ${corpusDir}, filters ${filters})`);
  }
  if (opts.update) {
    const touched = new Set();
    for (const r of results) {
      if (r.vector.source !== 'mined') continue;
      if (r.status === 'unlabelled' || r.status === 'mismatch') {
        r.vector.expected = { kind: r.actual.kind, ...(r.actual.guard ? { guard: r.actual.guard } : {}) };
        r.status = 'match';
        touched.add(r.vector.file);
      }
    }
    for (const file of touched) writeJsonl(file, byFile.get(file).map(({ file: _f, ...v }) => v));
  }
  const report = formatReport(results, { elapsedMs: Date.now() - t0, shadowed: shadowed.length, viaCli });
  if (!opts.quiet) process.stdout.write(report);
  const has = (s) => results.some((r) => r.status === s);
  const exitCode = has('mismatch') || has('gap-closed') || has('crashed') || (viaCli && viaCli.mismatches.length > 0) ? 1 : has('unlabelled') ? 2 : 0;
  if (opts.json) fs.writeFileSync(opts.json, JSON.stringify(toJson(results, { exitCode, elapsedMs: Date.now() - t0, shadowed: shadowed.length, viaCli }), null, 2) + '\n');
  return { results, exitCode, report, shadowed: shadowed.length, viaCli };
}

const VALUE_FLAGS = new Map([
  ['--corpus', 'corpusDir'],
  ['--configs', 'configsDir'],
  ['--lang', 'lang'],
  ['--source', 'source'],
  ['--guard', 'guard'],
  ['--json', 'json'],
  ['--via', 'via'],
  ['--sample', 'sample'],
]);

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (VALUE_FLAGS.has(a)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) { process.stderr.write(`evals: ${a} requires a value\n`); process.exit(1); }
      o[VALUE_FLAGS.get(a)] = v;
      i++;
    }
    else if (a === '--update') o.update = true;
    else if (a === '--quiet') o.quiet = true;
    else { process.stderr.write(`unknown option ${a}\n`); process.exit(1); }
  }
  if (o.via !== undefined) {
    if (o.via !== 'cli') { process.stderr.write(`evals: --via only supports "cli"\n`); process.exit(1); }
    o.viaCli = true;
    delete o.via;
  }
  if (o.sample !== undefined) {
    const n = Number(o.sample);
    if (!Number.isInteger(n) || n < 1) { process.stderr.write(`evals: --sample must be an integer >= 1\n`); process.exit(1); }
    o.sample = n;
    if (!o.viaCli) process.stderr.write('evals: --sample has no effect without --via cli\n');
  }
  return o;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const opts = parseArgs(process.argv.slice(2));
  const quiet = opts.quiet; opts.quiet = true;
  try {
    const { exitCode, report, viaCli } = runSuite(opts);
    if (quiet) {
      const summary = report.trimEnd().split('\n').pop();
      const viaLine = viaCli ? `via cli: ${viaCli.checked} checked, ${viaCli.mismatches.length} envelope mismatches` : null;
      process.stdout.write((viaLine ? viaLine + '\n' : '') + summary + '\n');   // quiet: via cli line (if any), then the summary line
    } else {
      process.stdout.write(report);
    }
    process.exit(exitCode);
  } catch (e) {
    process.stderr.write(`evals: ${e.message}\n`);
    process.exit(1);
  }
}
