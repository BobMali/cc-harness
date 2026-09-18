const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const PREFIX_WORDS = new Set(['env', 'sudo', 'time', 'nice', 'command']);
const SKIP_AFTER_WRAPPER = new Set(['run', 'run-script', 'exec', 'dlx', 'x', '--', '-y', '--yes', '-s', '--silent', '-q', '--quiet']);
const GIT_SAFE_SUB = new Set(['status', 'diff', 'log', 'show', 'blame', 'grep', 'ls-files', 'rev-parse', 'branch', 'remote', 'add', 'commit', 'tag', 'describe']);

export function splitSegments(cmdline) {
  const segs = [];
  let cur = '';
  let q = null;
  let heredocTerm = null; // terminator word once a `<<TERM` has been seen, before its body starts
  let inHeredoc = false; // currently absorbing heredoc body lines verbatim
  let lineBuf = ''; // accumulates the current heredoc body line to compare against the terminator
  const s = String(cmdline);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];

    if (inHeredoc) {
      cur += c;
      if (c === '\n') {
        if (lineBuf.trim() === heredocTerm) {
          segs.push(cur); cur = '';
          inHeredoc = false; heredocTerm = null;
        }
        lineBuf = '';
      } else {
        lineBuf += c;
      }
      continue;
    }

    if (q) {
      cur += c;
      if (c === q) { q = null; continue; }
      if (c === '\\' && q === '"') {
        if (s[i + 1] === '\n') { i++; cur = cur.slice(0, -1); continue; } // line continuation: emit nothing
        cur += s[++i] ?? '';
      }
      continue;
    }
    if (c === "'" || c === '"') { q = c; cur += c; continue; }
    if (c === '\\') {
      if (s[i + 1] === '\n') { i++; continue; } // line continuation: emit nothing
      cur += c + (s[++i] ?? ''); continue;
    }
    if (heredocTerm === null && c === '<' && s[i + 1] === '<') {
      let j = i + 2;
      if (s[j] === '-') j++;
      let quote = null;
      if (s[j] === "'" || s[j] === '"') { quote = s[j]; j++; }
      const wordStart = j;
      while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++;
      const word = s.slice(wordStart, j);
      if (word && /^[A-Za-z_]/.test(word) && (!quote || s[j] === quote)) {
        if (quote) j++; // consume closing quote
        cur += s.slice(i, j);
        heredocTerm = word;
        i = j - 1;
        continue;
      }
    }
    if (c === '\n') {
      if (heredocTerm !== null) {
        inHeredoc = true;
        cur += c;
        lineBuf = '';
        continue;
      }
      segs.push(cur); cur = ''; continue;
    }
    if (c === ';') { segs.push(cur); cur = ''; continue; }
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
      else if (c === '\\' && q === '"') {
        if (s[i + 1] === '\n') { i++; continue; } // line continuation: emit nothing
        cur += s[++i] ?? '';
      }
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') { q = c; started = true; continue; }
    if (c === '\\') {
      if (s[i + 1] === '\n') { i++; continue; } // line continuation: emit nothing
      cur += s[++i] ?? ''; started = true; continue;
    }
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

const SHELL_WORDS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const SHORT_C = /^-[a-zA-Z]*c[a-zA-Z]*$/;   // -c, -lc, -ec, -xc ...
const SHORT_O = /^-[a-zA-Z]*[oO]$/;         // -o pipefail, -eo pipefail: the next token is the option's value

// The command string of `sh -c <string>` (also bash/zsh/dash/ksh, combined short flags,
// `--`, and `sudo`/path prefixes via resolveTool); null when the segment is not one.
export function shellBody(tokens) {
  const { word, args } = resolveTool(tokens);
  if (!SHELL_WORDS.has(word)) return null;
  let sawC = false;
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (t === '--') return sawC ? (args[i + 1] ?? null) : null;
    if (t.startsWith('-') && t.length > 1) {
      if (SHORT_C.test(t)) sawC = true;
      if (SHORT_O.test(t)) i++;
      continue;
    }
    return sawC ? t : null;
  }
  return null;
}

// splitSegments plus, after every `sh -c <string>` segment, the segments of that string
// (recursively, so nested wrappers unwind too). The wrapper segment itself is kept.
export function flattenSegments(cmdline) {
  const out = [];
  for (const seg of splitSegments(cmdline)) {
    out.push(seg);
    const body = shellBody(tokenize(seg));
    if (body) out.push(...flattenSegments(body));
  }
  return out;
}

export function redirectTargets(segment) {
  const s = String(segment);
  const out = [];
  let q = null;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (q) {
      if (c === q) { q = null; i++; continue; }
      if (c === '\\' && q === '"') { i += 2; continue; }
      i++; continue;
    }
    if (c === "'" || c === '"') { q = c; i++; continue; }
    if (c === '\\') { i += 2; continue; }
    if (c === '>') {
      const prev = s[i - 1];
      let j = i + 1;
      if (s[j] === '>') j++;
      const next = s[j];
      if (prev !== '&' && next !== '&') {
        let k = j;
        while (k < s.length && /\s/.test(s[k])) k++;
        let target = '';
        if (s[k] === '"' || s[k] === "'") {
          const qc = s[k]; k++;
          while (k < s.length && s[k] !== qc) { target += s[k]; k++; }
          k++; // consume closing quote
        } else {
          while (k < s.length && !/[\s&|;<>]/.test(s[k])) { target += s[k]; k++; }
        }
        if (target) out.push(target);
        i = k;
        continue;
      }
      i = j;
      continue;
    }
    i++;
  }
  return out;
}

function entrySaysWrite(tokens, w) {
  const hasWhen = Array.isArray(w.whenFlags);
  const hasUnless = Array.isArray(w.unlessFlags);
  if (hasWhen) {
    if (!w.whenFlags.some((f) => tokens.includes(f))) return false;
    if (hasUnless && w.unlessFlags.some((f) => tokens.includes(f))) return false;
    return true;
  }
  if (hasUnless) return !w.unlessFlags.some((f) => tokens.includes(f));
  return true;
}

export function isWrite(tokens, word, writeCommands = []) {
  for (const w of writeCommands) {
    if (w.cmd !== word) continue;
    if (entrySaysWrite(tokens, w)) return true;
  }
  return false;
}

// git [global opts] <subcommand> [args]; global opts like -C <dir>, -c k=v, and the
// long space-form globals (--git-dir <dir>, --work-tree <dir>, --namespace <ns>,
// --attr-source <tree-ish>, --config-env <name>=<envvar>) take a value. The `=` form
// (--work-tree=/x) is a single token and needs no special handling here.
// --exec-path is deliberately excluded: git has no space-form value for it (only
// `--exec-path=<path>`); a bare `--exec-path` prints the current exec path and exits
// before any subcommand runs, so treating the following token as its value would be wrong
// (and it must not be treated as an ordinary bare flag either — see the short-circuit below).
const GIT_GLOBAL_VALUE_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--attr-source', '--config-env']);
export function gitSubcommand(args) {
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) {
    // Exact match only: `--exec-path=<path>` (a single token) sets the path and git
    // proceeds normally, but a bare `--exec-path` prints it and exits(0) immediately,
    // so nothing after it ever runs as a subcommand.
    if (args[i] === '--exec-path') return { sub: '', rest: [] };
    if (GIT_GLOBAL_VALUE_OPTS.has(args[i])) i += 2; else i += 1;
  }
  return { sub: args[i] ?? '', rest: args.slice(i + 1) };
}

export function isSafe({ word, args }, config) {
  if (!word) return false;
  if (word === 'git') return GIT_SAFE_SUB.has(gitSubcommand(args).sub);
  const safe = new Set([...(config.builtinSafe ?? []), ...(config.commands?.safe ?? [])]);
  return safe.has(word);
}
