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

const HEREDOC = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*\n([\s\S]*?)\n\s*\2\s*$/m;

// Returns the commit message text, or null when the command carries no inline message.
export function extractCommitMessage(rawCommand, segment, tokens, readFile) {
  const parts = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '-m' || t === '--message') { if (i + 1 < tokens.length) parts.push(tokens[++i]); continue; }
    if (t.startsWith('--message=')) { parts.push(t.slice('--message='.length)); continue; }
    if (/^-[a-zA-Z]*m$/.test(t)) { if (i + 1 < tokens.length) parts.push(tokens[++i]); continue; }   // -am, -sm
    if (t === '-F' || t === '--file') {
      const f = tokens[i + 1];
      if (f === '-') { const m = HEREDOC.exec(rawCommand); return m ? m[3] : null; }
      if (f) { const body = readFile(f); return body === null || body === undefined ? null : String(body).replace(/\s+$/, ''); }
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
  const subject = message.split(/\r?\n/)[0] ?? '';
  if (!rules.regex.test(subject)) {
    let hint = `subject "${subject}" does not match ${rules.regex.source}`;
    if (rules.types.length) hint += `\n  allowed types: ${rules.types.join(' ')}`;
    if (rules.scopes.length) hint += `\n  allowed scopes: ${rules.scopes.join(' ')}`;
    hint += '\n  expected: type(scope): lower-case imperative subject, no trailing period, ≤ 65 chars after the colon';
    errors.push(hint);
  }
  if (rejectAttributionTrailers && TRAILER_PATTERNS.some((re) => re.test(message))) {
    errors.push('attribution trailers (Co-Authored-By, Claude-Session, "Generated with") are not allowed in this repository');
  }
  return errors;
}
