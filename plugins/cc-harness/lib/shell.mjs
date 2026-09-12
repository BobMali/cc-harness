const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const PREFIX_WORDS = new Set(['env', 'sudo', 'time', 'nice', 'command']);
const SKIP_AFTER_WRAPPER = new Set(['run', 'run-script', 'exec', 'dlx', 'x', '--', '-y', '--yes', '-s', '--silent', '-q', '--quiet']);
const GIT_SAFE_SUB = new Set(['status', 'diff', 'log', 'show', 'blame', 'grep', 'ls-files', 'rev-parse', 'branch', 'remote', 'add', 'commit', 'stash', 'tag', 'describe']);

export function splitSegments(cmdline) {
  const segs = [];
  let cur = '';
  let q = null;
  const s = String(cmdline);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      cur += c;
      if (c === q) q = null;
      else if (c === '\\' && q === '"') cur += s[++i] ?? '';
      continue;
    }
    if (c === "'" || c === '"') { q = c; cur += c; continue; }
    if (c === '\\') { cur += c + (s[++i] ?? ''); continue; }
    if (c === '\n' || c === ';') { segs.push(cur); cur = ''; continue; }
    if (c === '&' && cur.endsWith('>')) { cur += c; continue; }   // 2>&1
    if (c === '&' || c === '|') {
      if (s[i + 1] === c) i++;
      segs.push(cur); cur = '';
      continue;
    }
    cur += c;
  }
  segs.push(cur);
  return segs.map((x) => x.trim()).filter(Boolean);
}

export function tokenize(segment) {
  const toks = [];
  let cur = '';
  let started = false;
  let q = null;
  const s = String(segment);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) q = null;
      else if (c === '\\' && q === '"') cur += s[++i] ?? '';
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') { q = c; started = true; continue; }
    if (c === '\\') { cur += s[++i] ?? ''; started = true; continue; }
    if (/\s/.test(c)) { if (started) toks.push(cur); cur = ''; started = false; continue; }
    cur += c; started = true;
  }
  if (started) toks.push(cur);
  return toks;
}

const base = (t) => t.slice(t.lastIndexOf('/') + 1);

export function resolveTool(tokens, runnerWrappers = []) {
  let i = 0;
  while (i < tokens.length && (ENV_ASSIGN.test(tokens[i]) || PREFIX_WORDS.has(tokens[i]))) i++;
  if (i >= tokens.length) return { word: '', args: [] };
  let word = base(tokens[i]);
  i++;
  if (runnerWrappers.includes(word)) {
    while (i < tokens.length && SKIP_AFTER_WRAPPER.has(tokens[i])) i++;
    if (i < tokens.length) { word = base(tokens[i]); i++; }
  }
  return { word, args: tokens.slice(i) };
}

export function redirectTargets(segment) {
  const out = [];
  const re = /(?:^|[\s\d])>{1,2}\s*([^\s&|;<>]+)/g;
  let m;
  while ((m = re.exec(String(segment))) !== null) out.push(m[1]);
  return out;
}

export function isWrite(tokens, word, writeCommands = []) {
  for (const w of writeCommands) {
    if (w.cmd !== word) continue;
    if (Array.isArray(w.whenFlags)) return w.whenFlags.some((f) => tokens.includes(f));
    if (Array.isArray(w.unlessFlags)) return !w.unlessFlags.some((f) => tokens.includes(f));
    return true;
  }
  return false;
}

export function isSafe({ word, args }, config) {
  if (!word) return false;
  if (word === 'git') return GIT_SAFE_SUB.has(args.find((a) => !a.startsWith('-')) ?? '');
  const safe = new Set([...(config.builtinSafe ?? []), ...(config.commands?.safe ?? [])]);
  return safe.has(word);
}
