// How an edit relates to an existing test file. Shared by the test guard (to decide) and the
// eval miner (to classify), so both apply one definition.

// True when the edit only adds text after the current end of the file: a Write whose content
// starts with the current content, or Edit/MultiEdit steps whose old_string is the file's tail
// (trailing whitespace ignored) and whose new_string starts with that old_string.
export function isAppend(tool, ti, current) {
  if (tool === 'Write') return typeof ti.content === 'string' && ti.content.startsWith(current);
  const edits = editsOf(tool, ti);
  if (!edits) return false;
  let text = current;
  for (const e of edits) {
    if (!validEdit(e)) return false;
    const anchor = e.old_string.trimEnd();
    if (!anchor || !e.new_string.startsWith(e.old_string) || !text.trimEnd().endsWith(anchor)) return false;
    const idx = text.lastIndexOf(e.old_string);
    if (idx === -1) return false;
    text = text.slice(0, idx) + e.new_string + text.slice(idx + e.old_string.length);
  }
  return true;
}

// Languages whose test files are a sequence of top-level blocks the guard can recognise.
const LANGS = [
  { ext: /\.[cm]?[jt]sx?$/, start: /^(?:test|it|describe|context|suite)(?:\.\w+)*\s*\(/, group: /^(?:describe|context|suite)(?:\.\w+)*\s*\(/, close: /^\}\)?;?\s*$/, neutral: /^(?:\/\/.*|\/\*.*\*\/|import\b.*|\)|\];?|\};?)$/ },
  { ext: /\.go$/, start: /^func (?:Test|Benchmark|Example|Fuzz)\w*\s*\(/, close: /^\}\s*$/, neutral: /^(?:\/\/.*|import\b.*|package\b.*|\)|\})$/ },
];

// True when every Edit/MultiEdit step only adds one or more complete test blocks at a block
// boundary of a JS/TS or Go test file: the anchor is unique, the step adds whole lines at one
// point and changes no existing line, the line before the insertion point is a closed block, a
// neutral line, the file start, or (JS) a group opener such as `describe(`, the added blocks
// share that line's indentation (or sit deeper, after a group opener), begin with a test block
// opener, end with a block close, are brace- and paren-balanced outside strings and comments, and
// contain no other code at the block level. Writes and other languages are never block insertions.
export function isBlockInsertion(filePath, current, edits) {
  const lang = LANGS.find((l) => l.ext.test(String(filePath)));
  if (!lang || !Array.isArray(edits) || !edits.length) return false;
  let text = current;
  for (const e of edits) {
    const ins = insertion(text, e);
    if (!ins) return false;
    const ctx = boundary(text, ins.at, lang);
    if (!ctx || !wholeBlocks(ins.added, lang, ctx)) return false;
    text = ins.after;
  }
  return true;
}

// The whole lines an Edit step adds, if it adds lines at one point and leaves every existing
// line as it was: `at` is the offset of the first added line in the text before the step, `after`
// the text once it is applied. The anchor must occur exactly once. Null for any other step: a
// changed line, a removed line, or text appended to an existing line.
export function insertion(text, e) {
  if (!validEdit(e) || !e.old_string) return null;
  const idx = text.indexOf(e.old_string);
  if (idx === -1 || text.indexOf(e.old_string, idx + 1) !== -1) return null;
  const after = text.slice(0, idx) + e.new_string + text.slice(idx + e.old_string.length);
  const a = text.split('\n');
  const b = after.split('\n');
  if (b.length <= a.length) return null;
  let p = 0;
  while (p < a.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  if (p + s < a.length) return null;
  const at = p === 0 ? 0 : a.slice(0, p).join('\n').length + 1;
  return { added: b.slice(p, b.length - s).join('\n') + '\n', at, after };
}

// What the line before the insertion point allows: after a closed block, a neutral line, or the
// file start, added blocks share its indentation; right after a group opener they must be deeper.
function boundary(text, at, lang) {
  const before = text.slice(0, at);
  const after = text.slice(at);
  if (before !== '' && !before.endsWith('\n') && !after.startsWith('\n') && after !== '') return null;
  if (before.trim() === '') return { indent: '', deeper: false };
  const lines = before.trimEnd().split('\n');
  const raw = lines[lines.length - 1];
  const indent = raw.match(/^\s*/)[0];
  const last = raw.trim();
  if (lang.close.test(last) || lang.neutral.test(last) || (lang.start.test(last) && balanced(last))) return { indent, deeper: false };
  if (lang.group && lang.group.test(last) && !balanced(last)) return { indent, deeper: true };
  return null;
}

function wholeBlocks(added, lang, { indent, deeper }) {
  const rawLines = added.replace(/^\n+/, '').replace(/\s+$/, '').split('\n');
  const nonBlank = rawLines.filter((l) => l.trim());
  if (!nonBlank.length) return false;
  let base = indent;
  if (deeper) { base = nonBlank[0].match(/^\s*/)[0]; if (base.length <= indent.length || !base.startsWith(indent)) return false; }
  const lines = [];
  for (const l of rawLines) {
    if (!l.trim()) { lines.push(''); continue; }
    if (!l.startsWith(base)) return false;
    lines.push(l.slice(base.length));
  }
  let i = 0;
  while (i < lines.length && (lines[i] === '' || /^\s*\/\//.test(lines[i]))) i++;
  const last = lines[lines.length - 1];
  if (i >= lines.length || !lang.start.test(lines[i]) || !(lang.close.test(last) || (lang.start.test(last) && balanced(last)))) return false;   // the last block may be a one-liner
  for (const l of lines) {
    if (/^\S/.test(l) && !lang.start.test(l) && !lang.close.test(l) && !/^\/\//.test(l)) return false;   // other code at the block level
  }
  return balanced(added);
}

// Brace and paren balance, skipping string and template literals and comments.
function balanced(src) {
  let brace = 0; let paren = 0; let i = 0;
  while (i < src.length) {
    const c = src[i]; const n = src[i + 1];
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { const j = src.indexOf('*/', i + 2); i = j === -1 ? src.length : j + 2; continue; }
    if (c === '"' || c === "'" || c === '`') { i++; while (i < src.length && src[i] !== c) { if (src[i] === '\\') i++; if (c !== '`' && src[i] === '\n') break; i++; } i++; continue; }
    if (c === '{') brace++; else if (c === '}') brace--; else if (c === '(') paren++; else if (c === ')') paren--;
    if (brace < 0 || paren < 0) return false;
    i++;
  }
  return brace === 0 && paren === 0;
}

// Text an addition adds: after the current content (Write) or around each anchor (Edit steps).
export function addedText(tool, ti, current) {
  if (tool === 'Write') return typeof ti.content === 'string' ? ti.content.slice(current.length) : '';
  const edits = editsOf(tool, ti) ?? [];
  let text = current;
  return edits.map((e) => {
    const ins = insertion(text, e);
    if (ins) { text = ins.after; return ins.added; }
    return validEdit(e) ? (e.new_string.startsWith(e.old_string) ? e.new_string.slice(e.old_string.length) : e.new_string.endsWith(e.old_string) ? e.new_string.slice(0, e.new_string.length - e.old_string.length) : e.new_string) : '';
  }).join('\n');
}

// Markers that change how the tests already in the file run even though nothing existing was
// edited: focused tests skip their siblings, file-level hooks wrap them, TestMain owns the run.
const OTHER_TEST_MARKERS = [
  /\b(?:test|it|describe|context|suite)\.only\s*\(/, /\b(?:fit|fdescribe|fcontext|ftest)\s*\(/,
  /^\s*(?:beforeAll|beforeEach|afterAll|afterEach|before|after|setup|teardown)\s*\(/m,
  /\bfunc TestMain\s*\(/, /\bautouse\s*=\s*True\b/, /@pytest\.fixture\s*\([^)]*scope\s*=\s*["'](?:module|session)/,
];
export function affectsOtherTests(text) {
  for (const re of OTHER_TEST_MARKERS) { const m = re.exec(text); if (m) return m[0].trim(); }
  return null;
}

function editsOf(tool, ti) {
  if (tool === 'Edit') return [ti];
  return Array.isArray(ti.edits) && ti.edits.length ? ti.edits : null;
}
const validEdit = (e) => e && typeof e.old_string === 'string' && typeof e.new_string === 'string' && !e.replace_all;
