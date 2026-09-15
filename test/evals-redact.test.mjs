import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, MAX_LEN, MAX_HEREDOC_LINES } from '../evals/lib/redact.mjs';

const cwd = '/Users/alice/projects/app';

test('paths: cwd prefix → ., home dirs → ~', () => {
  assert.equal(redact('cat /Users/alice/projects/app/src/a.ts', { cwd }).text, 'cat ./src/a.ts');
  assert.equal(redact('ls /Users/bob/other /home/carol/x', { cwd }).text, 'ls ~/other ~/x');
  assert.equal(redact('cat "/Users/alice/projects/app/README.md"', { cwd }).text, 'cat "./README.md"');
  assert.equal(redact('echo /Users/alice:/home/bob', { cwd }).text, 'echo ~:~');
});

test('secrets drop the vector', () => {
  for (const c of [
    'export GITHUB_TOKEN=abc', 'echo $SECRET_KEY', 'curl -H "Authorization: Bearer x"', 'git clone https://u:p@host/repo',
    'cat id_rsa -----BEGIN RSA', 'echo deadbeefdeadbeefdeadbeefdeadbeef', 'echo QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=', 'set password=x', 'API_KEY=1 node x',
    'curl -u user:pass https://h', 'curl --user alice:hunter2 https://h',
    'git clone https://ghp_abcdefghijklmnopqrstuvwxyzABCDEFghi@github.com/x/y.git',
    'docker login -p hunter2 registry', 'mysql -u root -phunter2 db', 'sshpass -p hunter2 ssh host',
    'export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE', 'echo xoxb-1234567890-abcdefghij', 'echo sk-abcdefghijklmnopqrstuvwxyz',
    'curl -uuser:pass https://h',
  ]) assert.equal(redact(c, { cwd }).dropped, 'secret', c);
});

test('sensitive paths drop the vector', () => {
  for (const c of [
    'cat ~/.ssh/config', 'ls .gnupg', 'cat .env', 'cat .env.local', 'cat ~/.npmrc',
    'cat ~/.aws/credentials', 'cat ~/.netrc', 'cat ~/.git-credentials', 'cat ~/.kube/config', 'cat ~/.docker/config.json',
    'cat id_rsa', 'cp id_ed25519 /tmp/', 'cat certs/server.pem', 'echo done > .env)',
  ]) assert.equal(redact(c, { cwd }).dropped, 'sensitive-path', c);
  assert.equal(redact('cat .environment.md', { cwd }).dropped, null);
  assert.equal(redact('ls src/env/', { cwd }).dropped, null);
  assert.equal(redact('ls src/awesome', { cwd }).dropped, null);
  assert.equal(redact('cat README.md', { cwd }).dropped, null);
});

test('ordinary commands survive', () => {
  for (const c of [
    'npm test', 'git commit -m "feat: tokenizer"', 'go test ./...', 'cat a1b2c3',
    'cat src/lib/authorization.ts', 'grep -rn "Authorization" src/', 'grep -r "passwordless" src',
    'git push -u origin main', 'mkdir -p x', 'docker run -p 8080:80 img',
    'curl -u alice https://h', 'curl -u https://x', 'git fetch ssh://git@host', 'git remote add origin git@github.com:x/y.git',
    'cp -p a b', 'git log -p', 'psql -p 5432',
    'cat login.log && docker run -p 8080:80 img', 'grep login access.log; docker run -p 3000:3000 app',
    'npm run login-test -- -p 8080:80', 'echo mariadb-cluster status; git log -p src/', 'cat mysql-notes.txt && git log -p src/',
    'curl -u "$USER" https://h',
  ]) assert.equal(redact(c, { cwd }).dropped, null, c);
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

// --- Fix round 1 -------------------------------------------------------

test('C1: a cwd of "/" (or otherwise too short) does not disable redaction', () => {
  assert.equal(redact('export GITHUB_TOKEN=abc', { cwd: '/' }).dropped, 'secret');
  assert.equal(redact('cat /home/bob/.env', { cwd: '/' }).dropped, 'sensitive-path');
});

test('C1: the cwd substitution is anchored to a path boundary', () => {
  // cwd is "/Users/alice/app"; the text has "/Users/alice/app-other/..." which must
  // NOT be treated as cwd + "-other/..." (that would eat part of a sibling dir name).
  const r = redact('cat /Users/alice/app-other/x.ts', { cwd: '/Users/alice/app' });
  assert.equal(r.text, 'cat ~/app-other/x.ts');
});
