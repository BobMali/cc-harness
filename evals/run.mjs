#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

export function makeLangProject(lang, configsDir = DEFAULT_CONFIGS) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cc-harness-eval-${lang}-`));
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.copyFileSync(path.join(configsDir, `${lang}.json`), path.join(dir, '.claude', 'harness.json'));
  const loaded = loadConfig(dir);
  if (loaded.status !== 'ok') throw new Error(`config ${lang}: ${loaded.status} ${JSON.stringify(loaded.errors ?? [])}`);
  const marker = loaded.config.project.markerFile || MARKERS[lang];
  if (marker) writeEmpty(path.join(dir, marker));
  fs.mkdirSync(path.join(dir, 'githooks'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'githooks', 'conventional-regex.txt'), REGEX_FILE);
  for (const c of loaded.config.checks) if (c.ifExists) writeEmpty(path.join(dir, c.ifExists));   // so no check is skipped; exec is stubbed anyway
  return { dir, lang, config: loaded.config, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function writeEmpty(abs) { fs.mkdirSync(path.dirname(abs), { recursive: true }); if (!fs.existsSync(abs)) { fs.writeFileSync(abs, ''); return true; } return false; }

function inside(root, abs) { const rel = path.relative(root, abs); return rel && !rel.startsWith('..') && !path.isAbsolute(rel); }

export function evaluateVector(vector, project, dataDir) {
  const created = [];
  for (const rel of vector.fixture?.exists ?? []) {
    const abs = path.resolve(project.dir, rel);
    if (!inside(project.dir, abs)) continue;
    if (writeEmpty(abs)) created.push(abs);
  }
  try {
    const toolInput = vector.tool === 'Bash'
      ? { command: vector.input.command }
      : { file_path: path.resolve(project.dir, vector.input.file_path) };
    const input = { hook_event_name: vector.event, tool_name: vector.tool, tool_input: toolInput, session_id: 'eval', cwd: project.dir };
    const ctx = { event: vector.event, input, config: project.config, projectDir: project.dir, dataDir, pluginRoot: pluginRoot(), exec: vector.event === 'PostToolUse' ? FAIL_EXEC : STUB_EXEC, fs, now: () => Date.now() };
    const results = evaluateGuards(vector.event, ctx);
    const d = pickDecision(results.map((r) => r.decision));
    if (!d) return { kind: 'pass', guard: null, reason: null };
    const guard = results.find((r) => r.decision === d)?.guard ?? null;
    return { kind: d.kind, guard, reason: d.reason ?? null };
  } finally {
    for (const abs of created) fs.rmSync(abs, { force: true });
  }
}

export function compare(vector, actual) {
  const e = vector.expected;
  if (!e) return 'unlabelled';
  const same = e.kind === actual.kind && (!e.guard || e.guard === actual.guard);
  if (e.known_gap) return same ? 'gap-closed' : 'known-gap';
  return same ? 'match' : 'mismatch';
}

export function runSuite(opts = {}) {
  const t0 = Date.now();
  const corpusDir = path.resolve(opts.corpusDir ?? DEFAULT_CORPUS);
  const configsDir = path.resolve(opts.configsDir ?? DEFAULT_CONFIGS);
  const { vectors, byFile } = loadCorpus(corpusDir);
  const langs = opts.lang ? new Set(String(opts.lang).split(',')) : null;
  const selected = vectors.filter((v) => (!langs || langs.has(v.lang)) && (!opts.source || v.source === opts.source));
  for (const v of selected) { const errs = validateVector(v); if (errs.length) throw new Error(`${v.file}: ${v.id}: ${errs.join('; ')}`); }
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-harness-eval-data-'));
  const projects = new Map();
  const results = [];
  try {
    for (const v of selected) {
      if (!projects.has(v.lang)) projects.set(v.lang, makeLangProject(v.lang, configsDir));
      const actual = evaluateVector(v, projects.get(v.lang), dataDir);
      if (opts.guard && actual.guard !== opts.guard && !(v.expected?.guard === opts.guard)) continue;
      results.push({ vector: v, actual, status: compare(v, actual) });
    }
  } finally {
    for (const p of projects.values()) p.cleanup();
    fs.rmSync(dataDir, { recursive: true, force: true });
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
  const report = formatReport(results, { elapsedMs: Date.now() - t0 });
  if (!opts.quiet) process.stdout.write(report);
  const has = (s) => results.some((r) => r.status === s);
  const exitCode = has('mismatch') || has('gap-closed') ? 1 : has('unlabelled') ? 2 : 0;
  if (opts.json) fs.writeFileSync(opts.json, JSON.stringify(toJson(results, { exitCode, elapsedMs: Date.now() - t0 }), null, 2) + '\n');
  return { results, exitCode, report };
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i];
    if (a === '--corpus') o.corpusDir = val();
    else if (a === '--configs') o.configsDir = val();
    else if (a === '--lang') o.lang = val();
    else if (a === '--source') o.source = val();
    else if (a === '--guard') o.guard = val();
    else if (a === '--json') o.json = val();
    else if (a === '--update') o.update = true;
    else if (a === '--quiet') o.quiet = true;
    else { process.stderr.write(`unknown option ${a}\n`); process.exit(1); }
  }
  return o;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const opts = parseArgs(process.argv.slice(2));
  const quiet = opts.quiet; opts.quiet = true;
  const { exitCode, report } = runSuite(opts);
  process.stdout.write(quiet ? report.trimEnd().split('\n').pop() + '\n' : report);   // quiet: summary line only
  process.exit(exitCode);
}
