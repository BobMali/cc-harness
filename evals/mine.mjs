#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readJsonl, writeJsonl, vectorId, TOOLS } from './lib/corpus.mjs';
import { redact } from './lib/redact.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_FROM = path.join(os.homedir(), '.claude', 'projects');
const DEFAULT_OUT = path.join(HERE, 'corpus', 'mined');
const DEFAULT_WORDS_FILE = path.join(HERE, 'redact.local.json');
const LONGEST = 50;

// evals/redact.local.json (gitignored, never committed) holds { "words": [...] } —
// personal words (e.g. the user's own name) to drop from the mined corpus without
// hardcoding them in the public redactor. Missing file or malformed JSON → no words.
function loadWords(wordsFile, fsm) {
  if (!wordsFile || !fsm.existsSync(wordsFile)) return [];
  try {
    const data = JSON.parse(fsm.readFileSync(wordsFile, 'utf8'));
    return Array.isArray(data.words) ? data.words : [];
  } catch { return []; }
}

export function detectLang(cwd, fsm = fs) {
  const has = (f) => { try { return fsm.existsSync(path.join(cwd, f)); } catch { return false; } };
  if (!cwd || !has('.')) return 'none';
  if (has('go.mod')) return 'go';
  if (has('composer.json')) return 'php';
  if (has('package.json')) return 'ts';
  if (has('Package.swift')) return 'swift';
  try { if (fsm.readdirSync(cwd).some((f) => f.endsWith('.xcodeproj'))) return 'swift'; } catch { /* ignore */ }
  return 'none';
}

export function extractToolUses(record) {
  if (record?.type !== 'assistant') return [];
  const content = record.message?.content;
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const block of content) {
    if (block?.type !== 'tool_use' || !TOOLS.includes(block.name)) continue;
    const input = block.input ?? {};
    if (block.name === 'Bash') { if (typeof input.command === 'string') out.push({ tool: 'Bash', input: { command: input.command } }); }
    else if (typeof input.file_path === 'string') out.push({ tool: block.name, input: { file_path: input.file_path } });
  }
  return out;
}

function normCwd(cwd) {
  const c = typeof cwd === 'string' ? cwd.replace(/\/+$/, '') : '';
  return c.length >= 2 ? c : '';
}

// A cwd that names a home directory itself (no project subfolder) has the
// username as its whole basename — use "home" instead of leaking it via note.
function projectName(cwd) {
  if (!cwd) return 'unknown';
  const home = os.homedir().replace(/\/+$/, '');
  if (cwd === home || /^\/(Users|home)\/[^/]+\/?$/.test(cwd)) return 'home';
  return path.basename(cwd) || 'unknown';
}

// Relativize file_path against cwd when it lands inside cwd; otherwise keep it
// absolute (redact() then scrubs any /Users/<name> or /home/<name> prefix).
// Never falls back to process.cwd() — an absolute p is resolved in place.
// Returns null when an already-relative path escapes its base (e.g. "../x") —
// the caller drops that vector rather than ever store a path containing "..".
function relOrAbs(cwd, p) {
  const norm = (s) => s.replace(/\\/g, '/');
  if (!path.isAbsolute(p)) {
    const n = path.posix.normalize(norm(p));
    if (n.startsWith('..') || path.posix.isAbsolute(n)) return null;
    return n;
  }
  const abs = path.resolve(p);
  if (cwd) {
    const rel = path.relative(cwd, abs);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return norm(rel);
  }
  return norm(abs);
}

export function toVector(use, { cwd, lang, touched, month, project, words = [] }) {
  const isBash = use.tool === 'Bash';
  let raw;
  if (isBash) {
    raw = use.input.command;
  } else {
    raw = relOrAbs(cwd, use.input.file_path);
    if (raw === null) return { dropped: 'escaping-path' };
  }
  const r = redact(raw, { cwd, words });
  if (r.dropped) return { dropped: r.dropped };
  const input = isBash ? { command: r.text } : { file_path: r.text };
  let fixture;
  if (!isBash) {
    const existed = use.tool !== 'Write' || touched.has(r.text);
    if (existed) fixture = { exists: [r.text] };
    touched.add(r.text);
  }
  const v = { id: vectorId(lang, 'PreToolUse', use.tool, input, Boolean(fixture)), lang, event: 'PreToolUse', tool: use.tool, input };
  if (fixture) v.fixture = fixture;
  return { ...v, expected: null, source: 'mined', note: `${project} ${month}` };
}

export function mineFile(file, { fsm = fs, words = [] } = {}) {
  const vectors = [];
  const dropped = { secret: 0, 'sensitive-path': 0, 'escaping-path': 0, personal: 0 };
  const touched = new Set();
  const langCache = new Map();
  for (const line of fsm.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let rec; try { rec = JSON.parse(line); } catch { continue; }
    const uses = extractToolUses(rec);
    if (!uses.length) continue;
    const cwd = normCwd(rec.cwd);
    if (!langCache.has(cwd)) langCache.set(cwd, detectLang(cwd, fsm));
    const lang = langCache.get(cwd);
    const monthCandidate = String(rec.timestamp ?? '').slice(0, 7);
    const month = /^\d{4}-\d{2}$/.test(monthCandidate) ? monthCandidate : 'unknown';
    const project = projectName(cwd);
    for (const use of uses) {
      const v = toVector(use, { cwd, lang, touched, month, project, words });
      if (v.dropped) dropped[v.dropped] += 1; else vectors.push(v);
    }
  }
  return { vectors, dropped };
}

function walk(dir, fsm) {
  const out = [];
  for (const e of fsm.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, fsm)); else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out.sort();
}

export function mine({ from = DEFAULT_FROM, out = DEFAULT_OUT, wordsFile = DEFAULT_WORDS_FILE, fsm = fs, log = (s) => process.stdout.write(s + '\n') } = {}) {
  if (!fsm.existsSync(from)) throw new Error(`transcripts directory not found: ${from}`);
  const words = loadWords(wordsFile, fsm);
  const byLangNew = new Map();
  const dropped = { secret: 0, 'sensitive-path': 0, 'escaping-path': 0, personal: 0, shadowed: 0 };
  const seen = new Set();
  // A new vector whose id already exists in the sibling adversarial corpus is shadowed:
  // the adversarial corpus already labels that exact (lang, event, tool, input, fixture)
  // and mining it again would just be a duplicate id waiting to collide at eval time.
  const adversarialDir = path.join(out, '..', 'adversarial');
  const adversarialIds = new Set();
  if (fsm.existsSync(adversarialDir)) {
    for (const f of fsm.readdirSync(adversarialDir).filter((x) => x.endsWith('.jsonl'))) {
      for (const row of readJsonl(path.join(adversarialDir, f))) adversarialIds.add(row.id);
    }
  }
  for (const file of walk(from, fsm)) {
    const r = mineFile(file, { fsm, words });
    dropped.secret += r.dropped.secret; dropped['sensitive-path'] += r.dropped['sensitive-path']; dropped['escaping-path'] += r.dropped['escaping-path']; dropped.personal += r.dropped.personal;
    for (const v of r.vectors) {
      if (adversarialIds.has(v.id)) { dropped.shadowed += 1; continue; }
      if (seen.has(v.id)) continue;
      seen.add(v.id);
      if (!byLangNew.has(v.lang)) byLangNew.set(v.lang, []);
      byLangNew.get(v.lang).push(v);
    }
  }
  let added = 0;
  const byLang = {};
  const all = [];
  for (const [lang, fresh] of byLangNew) {
    const file = path.join(out, `${lang}.jsonl`);
    const existing = fsm.existsSync(file) ? readJsonl(file) : [];
    const ids = new Set(existing.map((v) => v.id));
    const appended = fresh.filter((v) => !ids.has(v.id));
    if (appended.length) writeJsonl(file, [...existing, ...appended]);
    added += appended.length;
    byLang[lang] = appended.length;
    all.push(...existing, ...appended);
  }
  const longest = [...all].sort((a, b) => JSON.stringify(b.input).length - JSON.stringify(a.input).length).slice(0, LONGEST);
  log(`mined ${added} new vector(s): ${Object.entries(byLang).map(([l, n]) => `${l}=${n}`).join(' ') || 'none'}; dropped secret=${dropped.secret} sensitive-path=${dropped['sensitive-path']} escaping-path=${dropped['escaping-path']} personal=${dropped.personal} shadowed=${dropped.shadowed}`);
  log(`${longest.length} longest vectors (review before committing):`);
  for (const v of longest) log(`  ${v.id}  ${v.tool}  ${JSON.stringify(v.input.command ?? v.input.file_path).slice(0, 160)}`);
  return { added, byLang, dropped, longest };
}

function parseArgs(argv) {
  const o = {};
  const FLAGS = new Map([['--from', 'from'], ['--out', 'out']]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!FLAGS.has(a)) { process.stderr.write(`unknown option ${a}\n`); process.exit(1); }
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) { process.stderr.write(`${a} requires a value\n`); process.exit(1); }
    o[FLAGS.get(a)] = v;
    i++;
  }
  return o;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const opts = parseArgs(process.argv.slice(2));
  try {
    mine(opts);
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exit(1);
  }
}
