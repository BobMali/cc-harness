import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const LANGS = ['ts', 'go', 'php', 'swift', 'none'];
export const EVENTS = ['PreToolUse', 'PostToolUse'];
export const TOOLS = ['Bash', 'Write', 'Edit', 'MultiEdit'];
export const KINDS = ['pass', 'ask', 'deny', 'block'];
export const SOURCES = ['mined', 'adversarial'];

export function normalisePayload(tool, input = {}) {
  const s = tool === 'Bash' ? String(input.command ?? '') : String(input.file_path ?? '');
  return s.replace(/[ \t]+/g, ' ').replace(/[ \t]*\n[ \t]*/g, '\n').trim();
}

export function vectorId(lang, event, tool, input, fixtureExists = false) {
  const key = `${lang}|${event}|${tool}|${normalisePayload(tool, input)}${fixtureExists ? '|exists' : ''}`;
  return `${lang}-${crypto.createHash('sha1').update(key).digest('hex').slice(0, 6)}`;
}

export function readJsonl(file) {
  const out = [];
  let content = fs.readFileSync(file, 'utf8');
  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
  const lines = content.split('\n');
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    try { out.push(JSON.parse(line)); } catch (e) { throw new Error(`${file}:${i + 1}: ${e.message}`); }
  });
  return out;
}

export function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  fs.renameSync(tmp, file);
}

export function loadCorpus(dir) {
  const vectors = [];
  const byFile = new Map();
  for (const source of SOURCES) {
    const sub = path.join(dir, source);
    if (!fs.existsSync(sub)) continue;
    for (const f of fs.readdirSync(sub).filter((x) => x.endsWith('.jsonl')).sort()) {
      const abs = path.resolve(sub, f);
      const rows = readJsonl(abs).map((v) => ({ ...v, source: v.source ?? source, file: abs }));
      byFile.set(abs, rows);
      vectors.push(...rows);
    }
  }
  return { vectors, byFile };
}

export function validateVector(v) {
  if (v === null || typeof v !== 'object') return ['vector must be an object'];
  const e = [];
  if (typeof v.id !== 'string' || !/^[a-z]+-[0-9a-f]{6}$/.test(v.id)) e.push(`id "${v.id}" must look like <lang>-<6 hex>`);
  if (!LANGS.includes(v.lang)) e.push(`lang "${v.lang}" must be one of ${LANGS.join(' ')}`);
  if (!EVENTS.includes(v.event)) e.push(`event "${v.event}" must be one of ${EVENTS.join(' ')}`);
  if (!TOOLS.includes(v.tool)) e.push(`tool "${v.tool}" must be one of ${TOOLS.join(' ')}`);
  if (!v.input || typeof v.input !== 'object') e.push('input must be an object');
  else if (v.tool === 'Bash' && typeof v.input.command !== 'string') e.push('input.command must be a string for Bash');
  else if (v.tool !== 'Bash' && typeof v.input.file_path !== 'string') e.push('input.file_path must be a string for edit tools');
  if (v.expected !== null && v.expected !== undefined) {
    if (typeof v.expected !== 'object') e.push('expected must be null or an object');
    else if (!KINDS.includes(v.expected.kind)) e.push(`expected.kind "${v.expected.kind}" must be one of ${KINDS.join(' ')}`);
  }
  if (!SOURCES.includes(v.source)) e.push(`source "${v.source}" must be mined or adversarial`);
  if (v.fixture && !Array.isArray(v.fixture.exists)) e.push('fixture.exists must be an array');
  return e;
}
