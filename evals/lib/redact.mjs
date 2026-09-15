export const MAX_LEN = 2000;
export const MAX_HEREDOC_LINES = 40;
const KEEP = 5;

export const SECRET_PATTERNS = [
  /(?:^|[^a-z])tokens?(?![a-z])/i, /(?:^|[^a-z])secrets?(?![a-z])/i, /(?:^|[^a-z])password(?![a-z])/i, /(?:^|[^a-z])api[_-]?key(?![a-z])/i, /authorization:/i,
  /:\/\/[^/\s:@]+:[^/\s@]+@/, /-----BEGIN/,
  /(?:^|[^A-Za-z0-9+/=])[A-Fa-f0-9]{32,}(?![A-Za-z0-9+/=])/,
  /(?:^|[^A-Za-z0-9+/=])(?=[A-Za-z+/]*\d)[A-Za-z0-9+/]{32,}={0,2}(?![A-Za-z0-9+/=])/,   // needs a digit so letters-only paths survive
  /(?:^|\s)(?:-u|--user)[= ]?[^\s:\/=-][^\s:\/]*:(?!\/)\S+/,
  /:\/\/[^/\s@:]{20,}@/,
  /(?:^|[\s;&|])(?:docker\s+login|login|mysql|mysqldump|mariadb|sshpass|smbclient)\s[^\n;&|]*-p\s*\S/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_\w{20,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|\bsk-[A-Za-z0-9_-]{20,}|\bsk_(?:live|test)_\w{10,}|\bglpat-[\w-]{20,}|\bAIza[\w-]{35}/,
];

export const SENSITIVE_PATHS = [
  /\.ssh(\/|\b)/, /\.gnupg(\/|\b)/, /(^|[\s"'/=])\.env(\.[A-Za-z0-9_.-]+)?(?=$|[^A-Za-z0-9_.-])/, /\.npmrc\b/,
  /\.aws(\/|\b)/, /\.kube(\/|\b)/, /\.docker\/config\.json/, /\.netrc\b/, /\.git-credentials\b/,
  /(^|[/\s"'])id_(?:rsa|dsa|ecdsa|ed25519)\b/, /\.(?:pem|p12|pfx)\b/,
];

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

export function redact(text, { cwd } = {}) {
  let t = String(text);
  const c = cwd ? cwd.replace(/\/+$/, '') : '';
  if (c.length >= 2) t = t.replace(new RegExp(`${escapeRe(c)}(?=/|\\s|["']|$)`, 'g'), '.');
  t = t.replace(/\/Users\/[^/\s"':;]+/g, '~').replace(/\/home\/[^/\s"':;]+/g, '~');
  if (SECRET_PATTERNS.some((re) => re.test(t))) return { text: t, dropped: 'secret' };
  if (SENSITIVE_PATHS.some((re) => re.test(t))) return { text: t, dropped: 'sensitive-path' };
  t = elideHeredocs(t);
  if (t.length > MAX_LEN) t = t.slice(0, MAX_LEN) + ' …[truncated]';
  return { text: t, dropped: null };
}

function elideHeredocs(t) {
  const lines = t.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    const m = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(lines[i]);
    if (!m) continue;
    const term = m[2];
    let j = i + 1;
    while (j < lines.length && lines[j].trim() !== term) j++;
    const body = lines.slice(i + 1, j);
    if (body.length > MAX_HEREDOC_LINES) {
      out.push(...body.slice(0, KEEP), `# … ${body.length - 2 * KEEP} lines elided …`, ...body.slice(-KEEP));
    } else out.push(...body);
    if (j < lines.length) out.push(lines[j]);
    i = j;
  }
  return out.join('\n');
}
