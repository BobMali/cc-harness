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
    const id = typeof block.id === 'string' ? { id: block.id } : {};   // pairs the call with its result record
    if (block.name === 'Bash') { if (typeof input.command === 'string') out.push({ ...id, tool: 'Bash', input: { command: input.command } }); }
    else if (typeof input.file_path === 'string') out.push({ ...id, tool: block.name, input: { file_path: input.file_path } });
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

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// A project directory named after (or containing) a personal word would otherwise leak that
// word into the committed note unredacted; fall back to the generic label instead.
function noteProjectName(cwd, words) {
  const name = projectName(cwd);
  if (words.some((w) => new RegExp('(?:^|[^A-Za-z])' + escapeRe(w) + '(?![A-Za-z])', 'i').test(name))) return 'project';
  return name;
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

// How an edit related to the existing file, from the tool result Claude Code records next to
// the call (oldString/newString/content plus the originalFile). undefined when the result is
// missing or the file was new. Mirrors the test guard's append rule.
export function editShape(use, result) {
  if (use.tool === 'Bash' || !result || typeof result !== 'object') return undefined;
  const orig = result.originalFile;
  if (typeof orig !== 'string') return undefined;
  if (use.tool === 'Write') return typeof result.content === 'string' && result.content.startsWith(orig) ? 'append' : 'replace';
  const old = result.oldString; const neu = result.newString;
  if (typeof old !== 'string' || typeof neu !== 'string') return undefined;
  if (result.replaceAll || !neu.includes(old)) return 'replace';
  return old.trim() && neu.startsWith(old) && orig.trimEnd().endsWith(old.trimEnd()) ? 'append' : 'insert';
}

export function toVector(use, { cwd, lang, touched, month, project, words = [], result }) {
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
  const shape = editShape(use, result);
  if (shape) input.shape = shape;
  let fixture;
  if (!isBash) {
    const existed = use.tool !== 'Write' || touched.has(r.text);
    if (existed) fixture = { exists: [r.text] };
    touched.add(r.text);
  }
  const events = isBash ? ['PreToolUse'] : ['PreToolUse', 'PostToolUse'];   // edit tools also feed the quality gate
  const vectors = events.map((event) => {
    const v = { id: vectorId(lang, event, use.tool, input, Boolean(fixture)), lang, event, tool: use.tool, input };
    if (fixture) v.fixture = fixture;
    return { ...v, expected: null, source: 'mined', note: `${project} ${month}` };
  });
  return { vectors };
}

// The PostToolUse twin of an edit-tool PreToolUse row: same input and fixture, its own id.
function twinOf(row) {
  const twin = { id: vectorId(row.lang, 'PostToolUse', row.tool, row.input, Boolean(row.fixture)), lang: row.lang, event: 'PostToolUse', tool: row.tool, input: row.input };
  if (row.fixture) twin.fixture = row.fixture;
  return { ...twin, expected: null, source: row.source, note: row.note };
}

export function mineFile(file, { fsm = fs, words = [] } = {}) {
  const vectors = [];
  const dropped = { secret: 0, 'sensitive-path': 0, 'escaping-path': 0, personal: 0 };
  const touched = new Set();
  const langCache = new Map();
  const lines = fsm.readFileSync(file, 'utf8').split('\n');
  // Tool results follow their calls as user records; pair them by tool_use_id first.
  const results = new Map();
  for (const line of lines) {
    if (!line.includes('toolUseResult')) continue;
    let rec; try { rec = JSON.parse(line); } catch { continue; }
    const id = rec?.message?.content?.[0]?.tool_use_id;
    if (typeof id === 'string' && rec.toolUseResult && typeof rec.toolUseResult === 'object') results.set(id, rec.toolUseResult);
  }
  for (const line of lines) {
    if (!line.trim()) continue;
    let rec; try { rec = JSON.parse(line); } catch { continue; }
    const uses = extractToolUses(rec);
    if (!uses.length) continue;
    const cwd = normCwd(rec.cwd);
    if (!langCache.has(cwd)) langCache.set(cwd, detectLang(cwd, fsm));
    const lang = langCache.get(cwd);
    const monthCandidate = String(rec.timestamp ?? '').slice(0, 7);
    const month = /^\d{4}-\d{2}$/.test(monthCandidate) ? monthCandidate : 'unknown';
    const project = noteProjectName(cwd, words);
    for (const use of uses) {
      const v = toVector(use, { cwd, lang, touched, month, project, words, result: use.id ? results.get(use.id) : undefined });
      if (v.dropped) dropped[v.dropped] += 1; else vectors.push(...v.vectors);
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

// --rebuild: re-run every existing corpus row through the current redactor (cwd unknown at
// rebuild time, so only structural rules and the word list apply). Each fixture.exists entry is
// re-redacted the same way as the payload — a tightened rule can leave a stale entry behind
// otherwise. A row dropped on its payload or any fixture entry is removed; a row whose payload,
// id, or fixture entries change is rewritten in place; rows that collapse onto the same id keep
// only the first (the discarded row counts under "removed", never under "changed"). Returns
// per-file counts merged into the caller's dropped.rebuilt total.
function rebuildFile(file, lang, words) {
  const rows = readJsonl(file);
  const seen = new Set();
  const kept = [];
  let changed = 0;
  let removed = 0;
  for (const row of rows) {
    const isBash = row.tool === 'Bash';
    const text = isBash ? row.input.command : row.input.file_path;
    const r = redact(text, { cwd: undefined, words });
    if (r.dropped) { removed += 1; continue; }
    const input = isBash ? { command: r.text } : { file_path: r.text };
    if (!isBash && row.input.shape) input.shape = row.input.shape;

    let fixture = row.fixture;
    let fixtureChanged = false;
    if (row.fixture && Array.isArray(row.fixture.exists)) {
      const nextExists = [];
      let fixtureDropped = false;
      for (const entry of row.fixture.exists) {
        const fr = redact(entry, { cwd: undefined, words });
        if (fr.dropped) { fixtureDropped = true; break; }
        if (fr.text !== entry) fixtureChanged = true;
        nextExists.push(fr.text);
      }
      if (fixtureDropped) { removed += 1; continue; }
      fixture = { exists: nextExists };
    }

    const id = vectorId(lang, row.event, row.tool, input, Boolean(fixture));
    if (seen.has(id)) { removed += 1; continue; }   // two rows collapsed onto one id: keep the first
    seen.add(id);
    if (id !== row.id || r.text !== text || fixtureChanged) changed += 1;
    const newRow = { id, lang: row.lang, event: row.event, tool: row.tool, input };
    if (fixture) newRow.fixture = fixture;
    newRow.expected = row.expected;
    newRow.source = row.source;
    newRow.note = row.note;
    kept.push(newRow);
  }
  // Back-fill: every edit-tool PreToolUse row gets its PostToolUse twin if the corpus lacks it.
  let paired = 0;
  for (const row of [...kept]) {
    if (row.tool === 'Bash' || row.event !== 'PreToolUse') continue;
    const twin = twinOf(row);
    if (seen.has(twin.id)) continue;
    seen.add(twin.id); kept.push(twin); paired += 1;
  }
  writeJsonl(file, kept);
  return { changed, removed, paired };
}

export function mine(opts = {}) {
  const { out = DEFAULT_OUT, wordsFile = DEFAULT_WORDS_FILE, rebuild = false, fsm = fs, log = (s) => process.stdout.write(s + '\n') } = opts;
  // --rebuild is a corpus-only operation: when it is passed with no explicit --from, skip the
  // transcript walk entirely rather than defaulting to (and possibly failing on) ~/.claude/projects.
  const fromProvided = opts.from !== undefined;
  const skipWalk = rebuild && !fromProvided;
  const from = fromProvided ? opts.from : DEFAULT_FROM;
  if (!skipWalk && !fsm.existsSync(from)) throw new Error(`transcripts directory not found: ${from}`);
  const words = loadWords(wordsFile, fsm);
  let rebuiltRemoved = 0;
  let paired = 0;
  if (rebuild && fsm.existsSync(out)) {
    let rebuiltChanged = 0;
    for (const f of fsm.readdirSync(out).filter((x) => x.endsWith('.jsonl')).sort()) {
      const lang = f.slice(0, -'.jsonl'.length);
      const r = rebuildFile(path.join(out, f), lang, words);
      rebuiltChanged += r.changed;
      rebuiltRemoved += r.removed;
      paired += r.paired;
    }
    log(`rebuilt: ${rebuiltChanged} changed, ${rebuiltRemoved} removed, ${paired} PostToolUse twin(s) added`);
  }
  const byLangNew = new Map();
  const dropped = { secret: 0, 'sensitive-path': 0, 'escaping-path': 0, personal: 0, shadowed: 0, rebuilt: rebuiltRemoved };
  const seen = new Set();
  if (!skipWalk) {
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
  }
  let added = 0;
  let upgraded = 0;
  const byLang = {};
  const all = [];
  for (const [lang, fresh] of byLangNew) {
    const file = path.join(out, `${lang}.jsonl`);
    let existing = fsm.existsSync(file) ? readJsonl(file) : [];
    // A shaped vector supersedes a shapeless row for the same edit (mined before shapes existed).
    const shapedKeys = new Set(fresh.filter((v) => v.input.shape).map((v) => `${v.event}|${v.tool}|${v.input.file_path}|${Boolean(v.fixture)}`));
    const before = existing.length;
    existing = existing.filter((v) => v.tool === 'Bash' || v.input.shape || !shapedKeys.has(`${v.event}|${v.tool}|${v.input.file_path}|${Boolean(v.fixture)}`));
    upgraded += before - existing.length;
    const ids = new Set(existing.map((v) => v.id));
    const appended = fresh.filter((v) => !ids.has(v.id));
    if (appended.length || before !== existing.length) writeJsonl(file, [...existing, ...appended]);
    added += appended.length;
    byLang[lang] = appended.length;
    all.push(...existing, ...appended);
  }
  const longest = [...all].sort((a, b) => JSON.stringify(b.input).length - JSON.stringify(a.input).length).slice(0, LONGEST);
  log(`mined ${added} new vector(s): ${Object.entries(byLang).map(([l, n]) => `${l}=${n}`).join(' ') || 'none'}; upgraded ${upgraded} shapeless row(s); dropped secret=${dropped.secret} sensitive-path=${dropped['sensitive-path']} escaping-path=${dropped['escaping-path']} personal=${dropped.personal} shadowed=${dropped.shadowed}`);
  log(`${longest.length} longest vectors (review before committing):`);
  for (const v of longest) log(`  ${v.id}  ${v.tool}  ${JSON.stringify(v.input.command ?? v.input.file_path).slice(0, 160)}`);
  return { added, byLang, dropped, longest, paired, upgraded };
}

function parseArgs(argv) {
  const o = {};
  const FLAGS = new Map([['--from', 'from'], ['--out', 'out']]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--rebuild') { o.rebuild = true; continue; }
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
