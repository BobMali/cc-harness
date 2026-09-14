import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, MAX_LEN, MAX_HEREDOC_LINES } from '../evals/lib/redact.mjs';

const cwd = '/Users/alice/projects/app';

test('paths: cwd prefix → ., home dirs → ~', () => {
  assert.equal(redact('cat /Users/alice/projects/app/src/a.ts', { cwd }).text, 'cat ./src/a.ts');
  assert.equal(redact('ls /Users/bob/other /home/carol/x', { cwd }).text, 'ls ~/other ~/x');
  assert.equal(redact('cat "/Users/alice/projects/app/README.md"', { cwd }).text, 'cat "./README.md"');
});

test('secrets drop the vector', () => {
  for (const c of [
    'export GITHUB_TOKEN=abc', 'echo $SECRET_KEY', 'curl -H "Authorization: Bearer x"', 'git clone https://u:p@host/repo',
    'cat id_rsa -----BEGIN RSA', 'echo deadbeefdeadbeefdeadbeefdeadbeef', 'echo QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=', 'set password=x', 'API_KEY=1 node x',
  ]) assert.equal(redact(c, { cwd }).dropped, 'secret', c);
});

test('sensitive paths drop the vector', () => {
  for (const c of ['cat ~/.ssh/config', 'ls .gnupg', 'cat .env', 'cat .env.local', 'cat ~/.npmrc']) assert.equal(redact(c, { cwd }).dropped, 'sensitive-path', c);
  assert.equal(redact('cat .environment.md', { cwd }).dropped, null);
  assert.equal(redact('ls src/env/', { cwd }).dropped, null);
});

test('ordinary commands survive', () => {
  for (const c of ['npm test', 'git commit -m "feat: tokenizer"', 'go test ./...', 'cat a1b2c3']) assert.equal(redact(c, { cwd }).dropped, null, c);
});

test('long commands are truncated; long heredoc bodies are elided', () => {
  const long = 'echo ' + 'x'.repeat(MAX_LEN + 100);
  const r = redact(long, { cwd });
  assert.ok(r.text.length <= MAX_LEN + 20); assert.match(r.text, /…\[truncated\]$/);
  const body = Array.from({ length: MAX_HEREDOC_LINES + 10 }, (_, i) => `line ${i}`).join('\n');
  const h = redact(`cat > f.md <<'EOF'\n${body}\nEOF\nls`, { cwd });
  assert.match(h.text, /^cat > f\.md <<'EOF'\nline 0\n/);
  assert.match(h.text, /# … 40 lines elided …/);
  assert.match(h.text, /line 49\nEOF\nls$/);
  const short = redact(`cat <<EOF\na\nb\nEOF`, { cwd });
  assert.equal(short.text, `cat <<EOF\na\nb\nEOF`);
});
