export const TRAILER_PATTERNS = [
  /^co-authored-by:/im,
  /^claude-session:/im,
  /generated with .*claude/i,
];

export function parseRegexFile(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const line1 = (lines[0] ?? '').trim();
  const grab = (label) => {
    const l = lines.find((x) => x.startsWith(`# ${label}:`));
    return l ? l.slice(label.length + 3).trim().split(/\s+/).filter(Boolean) : [];
  };
  const out = { regex: null, types: grab('types'), scopes: grab('scopes') };
  if (!line1) return { ...out, error: 'regex file is empty' };
  try { out.regex = new RegExp(line1); } catch (e) { out.error = `invalid regex on line 1: ${e.message}`; }
  return out;
}

// Captures whether `<<-` (tab-stripping) was used, the quote around the terminator, the
// terminator word, and the body. Matched against a single segment (never the whole command,
// which may carry unrelated heredocs of its own).
const HEREDOC = /<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2[^\n]*\n([\s\S]*?)\n\s*\3\s*$/m;

// `$(cat <<[-]TERM ... TERM)`, the idiom Claude Code commonly writes for multi-line -m values.
const CAT_HEREDOC = /^\$\(\s*cat\s+<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2\s*\n([\s\S]*?)\n\s*\3\s*\n?\s*\)\s*$/;

function stripLeadingTabs(body) {
  return body.split('\n').map((l) => l.replace(/^\t+/, '')).join('\n');
}

// Resolves a raw -m/--message value. Returns { ok: true, value } when the value is a plain
// string or a recognised `$(cat <<EOF ...)` idiom (expanded to its body); returns { ok: false }
// when the value still contains an unresolved `$( )` or backtick substitution the guard cannot
// safely evaluate — the caller then bails out entirely and defers to the (authoritative) hook.
function resolveValue(value) {
  const m = CAT_HEREDOC.exec(value);
  if (m) return { ok: true, value: m[1] === '-' ? stripLeadingTabs(m[4]) : m[4] };
  if (/\$\(|`/.test(value)) return { ok: false };
  return { ok: true, value };
}

// Returns the commit message text, or null when the command carries no inline message
// (or carries one the guard cannot safely resolve, e.g. an un-expandable command substitution).
export function extractCommitMessage(rawCommand, segment, tokens, readFile) {
  const parts = [];
  const push = (raw) => {
    const r = resolveValue(raw);
    if (!r.ok) return false;
    parts.push(r.value);
    return true;
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '-m' || t === '--message') { if (i + 1 < tokens.length) { if (!push(tokens[++i])) return null; } continue; }
    if (t.startsWith('--message=')) { if (!push(t.slice('--message='.length))) return null; continue; }
    // -m"msg", -am"msg"; a leading -C/-c/-F/-t owns the rest of the token (git's
    // getopt-style short-option clusters stop at the first value-taking flag), so
    // it is not an attached -m. The per-character lookahead stops the prefix scan
    // right at that flag (or at the first "m"); it must not look past the "m" into
    // the message value itself, or a value starting with a plain "t"/"c" (feat,
    // chore, ...) would be wrongly rejected.
    const attached = /^-(?:(?!m|[CcFt])[a-zA-Z])*m(.+)$/.exec(t);
    if (attached) { if (!push(attached[1])) return null; continue; }
    if (/^-[a-zA-Z]*m$/.test(t)) { if (i + 1 < tokens.length) { if (!push(tokens[++i])) return null; } continue; }   // -am, -sm
    if (t === '-F' || t === '--file') {
      const f = tokens[i + 1];
      if (f === '-') { const m = HEREDOC.exec(segment); if (!m) return null; return m[1] === '-' ? stripLeadingTabs(m[4]) : m[4]; }
      if (f) { const body = readFile(f); return body === null || body === undefined ? null : String(body).replace(/\s+$/, ''); }
    }
    const attachedFile = /^-F(.+)$/.exec(t);   // -Fmsg.txt (attached form of -F/--file)
    if (attachedFile) {
      const f = attachedFile[1];
      if (f === '-') { const m = HEREDOC.exec(segment); if (!m) return null; return m[1] === '-' ? stripLeadingTabs(m[4]) : m[4]; }
      const body = readFile(f); return body === null || body === undefined ? null : String(body).replace(/\s+$/, '');
    }
    if (t.startsWith('--file=')) { const body = readFile(t.slice(7)); return body == null ? null : String(body).replace(/\s+$/, ''); }
  }
  return parts.length ? parts.join('\n\n') : null;
}

export function checkMessage(message, rules, { rejectAttributionTrailers = true } = {}) {
  const errors = [];
  if (!rules.regex) {
    errors.push(`the commit regex file could not be used (${rules.error ?? 'missing'}); fix it before committing`);
    return errors;
  }
  const subject = (message.split(/\r?\n/)[0] ?? '').replace(/\r$/, '');
  if (!rules.regex.test(subject)) {
    let hint = `subject "${subject}" does not match ${rules.regex.source}`;
    if (rules.types.length) hint += `\n  allowed types: ${rules.types.join(' ')}`;
    if (rules.scopes.length) hint += `\n  allowed scopes: ${rules.scopes.join(' ')}`;
    hint += '\n  expected: type(scope): lower-case imperative subject, no trailing period, ≤ 66 chars after the colon';
    errors.push(hint);
  }
  if (rejectAttributionTrailers && TRAILER_PATTERNS.some((re) => re.test(message))) {
    errors.push('attribution trailers (Co-Authored-By, Claude-Session, "Generated with") are not allowed in this repository');
  }
  return errors;
}
