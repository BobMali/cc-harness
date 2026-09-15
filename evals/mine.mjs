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
const LONGEST = 50;

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

const relPath = (cwd, p) => (path.isAbsolute(p) ? path.relative(cwd, p) : p).replace(/\\/g, '/');

export function toVector(use, { cwd, lang, touched, month, project }) {
  const isBash = use.tool === 'Bash';
  const raw = isBash ? use.input.command : relPath(cwd, use.input.file_path);
  const r = redact(raw, { cwd });
  if (r.dropped) return { dropped: r.dropped };
  const input = isBash ? { command: r.text } : { file_path: r.text };
  let fixture;
  if (!isBash) {
    const existed = use.tool !== 'Write' || touched.has(r.text);
    if (existed) fixture = { exists: [r.text] };
    touched.add(r.text);
  }
  const v = { id: vectorId(lang, use.tool, input, Boolean(fixture)), lang, event: 'PreToolUse', tool: use.tool, input };
  if (fixture) v.fixture = fixture;
  return { ...v, expected: null, source: 'mined', note: `${project} ${month}` };
}

export function mineFile(file, { fsm = fs } = {}) {
  const vectors = [];
  const dropped = { secret: 0, 'sensitive-path': 0 };
  const touched = new Set();
  const langCache = new Map();
  for (const line of fsm.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let rec; try { rec = JSON.parse(line); } catch { continue; }
    const uses = extractToolUses(rec);
    if (!uses.length) continue;
    const cwd = typeof rec.cwd === 'string' ? rec.cwd : '';
    if (!langCache.has(cwd)) langCache.set(cwd, detectLang(cwd, fsm));
    const lang = langCache.get(cwd);
    const month = String(rec.timestamp ?? '').slice(0, 7) || 'unknown';
    const project = path.basename(cwd) || 'unknown';
    for (const use of uses) {
      const v = toVector(use, { cwd, lang, touched, month, project });
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

export function mine({ from = DEFAULT_FROM, out = DEFAULT_OUT, fsm = fs, log = (s) => process.stdout.write(s + '\n') } = {}) {
  const byLangNew = new Map();
  const dropped = { secret: 0, 'sensitive-path': 0 };
  const seen = new Set();
  for (const file of walk(from, fsm)) {
    const r = mineFile(file, { fsm });
    dropped.secret += r.dropped.secret; dropped['sensitive-path'] += r.dropped['sensitive-path'];
    for (const v of r.vectors) {
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
  log(`mined ${added} new vector(s): ${Object.entries(byLang).map(([l, n]) => `${l}=${n}`).join(' ') || 'none'}; dropped secret=${dropped.secret} sensitive-path=${dropped['sensitive-path']}`);
  log(`${longest.length} longest vectors (review before committing):`);
  for (const v of longest) log(`  ${v.id}  ${v.tool}  ${JSON.stringify(v.input.command ?? v.input.file_path).slice(0, 160)}`);
  return { added, byLang, dropped, longest };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const a = process.argv.slice(2);
  const val = (f) => { const i = a.indexOf(f); return i === -1 ? undefined : a[i + 1]; };
  mine({ from: val('--from'), out: val('--out') });
}
