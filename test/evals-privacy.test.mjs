import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJsonl, vectorId } from '../evals/lib/corpus.mjs';
import { redact } from '../evals/lib/redact.mjs';

// A structural privacy sweep over the committed corpus itself (not the redactor's unit tests):
// every row actually on disk must already be clean. This is a static check on data, not on
// behaviour — it has no fixtures of its own and reads the real evals/corpus directory.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS = path.join(ROOT, 'evals', 'corpus');

const TOP_KEYS = new Set(['id', 'lang', 'event', 'tool', 'input', 'fixture', 'expected', 'source', 'note']);
const INPUT_KEYS = new Set(['command', 'file_path']);
const UUID_PLACEHOLDER = '00000000-0000-4000-8000-000000000000';
const SESSION_PLACEHOLDER = 'session_00000000000000000000000000';
const EMAIL_ALLOWLIST = 'noreply@anthropic.com';

function collectRows(dir) {
  if (!fs.existsSync(dir)) return [];
  const rows = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.jsonl')).sort()) {
    for (const row of readJsonl(path.join(dir, f))) rows.push({ row, file: path.join(path.basename(dir), f) });
  }
  return rows;
}

// "-Users-" / "-home-" is Claude Code's project-directory encoding; redact() leaves the dashed
// skeleton in place and swaps only the name for "~", so the char right after the marker must be
// "~" (or nothing, if the marker sits at the very end of the string untouched).
function leaksEncodedDir(s) {
  const re = /-(?:Users|home)-(.)?/g;
  let m;
  while ((m = re.exec(s))) {
    if (m[1] !== undefined && m[1] !== '~') return true;
  }
  return false;
}

test('privacy: every committed corpus row is shaped and redacted as expected', () => {
  const rows = [...collectRows(path.join(CORPUS, 'mined')), ...collectRows(path.join(CORPUS, 'adversarial'))];
  assert.ok(rows.length > 0, 'expected at least one corpus row to check');
  const bad = [];
  for (const { row, file } of rows) {
    const where = `${file} ${row.id}`;
    for (const k of Object.keys(row)) if (!TOP_KEYS.has(k)) bad.push(`${where}: unexpected top-level key "${k}"`);
    if (row.input && typeof row.input === 'object') {
      for (const k of Object.keys(row.input)) if (!INPUT_KEYS.has(k)) bad.push(`${where}: unexpected input key "${k}"`);
    }
    const payload = row.tool === 'Bash' ? row.input?.command : row.input?.file_path;
    if (typeof payload === 'string') {
      const r = redact(payload, { cwd: undefined });
      if (r.dropped) bad.push(`${where}: redact(payload) drops as "${r.dropped}"`);
      if (/\/(?:Users|home)\/(?!~)/.test(payload)) bad.push(`${where}: leaked /Users or /home path: ${payload}`);
      if (leaksEncodedDir(payload)) bad.push(`${where}: leaked -Users- or -home- project-dir encoding: ${payload}`);
      const emails = payload.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g) || [];
      for (const e of emails) if (e !== EMAIL_ALLOWLIST) bad.push(`${where}: leaked email "${e}"`);
      const uuids = payload.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) || [];
      for (const u of uuids) if (u.toLowerCase() !== UUID_PLACEHOLDER) bad.push(`${where}: leaked UUID "${u}"`);
      const sessions = payload.match(/\bsession_[A-Za-z0-9]{20,}\b/g) || [];
      for (const s of sessions) if (s !== SESSION_PLACEHOLDER) bad.push(`${where}: leaked session id "${s}"`);
    }
    const expectedId = vectorId(row.lang, row.event, row.tool, row.input, Boolean(row.fixture));
    if (expectedId !== row.id) bad.push(`${file}: id "${row.id}" does not re-derive (expected "${expectedId}")`);
  }
  assert.deepEqual(bad, []);
});
