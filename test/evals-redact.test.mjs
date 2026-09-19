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

// --- Fix round 3 --------------------------------------------------------

test('Claude Code project-directory encodings and session UUIDs are rewritten', () => {
  assert.equal(
    redact('cat ~/.claude/projects/-Users-alice-projects-app/memory/x.md', { cwd }).text,
    'cat ~/.claude/projects/-Users-~-projects-app/memory/x.md',
  );
  assert.equal(
    redact('/private/tmp/claude-501/-home-bob-src/x', { cwd }).text,
    '/private/tmp/claude-501/-home-~-src/x',
  );
  assert.equal(redact('echo -Users-', { cwd }).text, 'echo -Users-');

  const PLACEHOLDER = '00000000-0000-4000-8000-000000000000';
  assert.equal(
    redact('cat /private/tmp/claude-501/x/071c35b9-0cf2-4f94-8944-f98ff20e57b4/scratchpad/notes.md', { cwd }).text,
    `cat /private/tmp/claude-501/x/${PLACEHOLDER}/scratchpad/notes.md`,
  );
  assert.equal(
    redact('diff 071c35b9-0cf2-4f94-8944-f98ff20e57b4 a1b2c3d4-e5f6-7890-abcd-ef1234567890', { cwd }).text,
    `diff ${PLACEHOLDER} ${PLACEHOLDER}`,
  );
});

test('emails drop the vector except the allowlisted noreply address', () => {
  assert.equal(redact('git config user.email alice@example.com', { cwd }).dropped, 'secret');
  assert.equal(redact('git commit -m "feat: x" -m "Co-Authored-By: Claude <noreply@anthropic.com>"', { cwd }).dropped, null);
  for (const c of ['go get gremlins@v0.6.0', 't@t', 'a@b.c', 'x@y']) assert.equal(redact(c, { cwd }).dropped, null, c);
});

test('personal words drop the vector as a whole word, case-insensitively', () => {
  assert.equal(redact('echo Alice asked', { words: ['Alice'] }).dropped, 'personal');
  assert.equal(redact('echo malicious', { words: ['Alice'] }).dropped, null);
  assert.equal(redact('cat ALICE.md', { words: ['Alice'] }).dropped, 'personal');
});

// --- Final wave ----------------------------------------------------------

test('item 1: session ids are rewritten; short faux session_ ids are left alone', () => {
  assert.equal(
    redact('Claude-Session: https://claude.ai/code/session_01AbCdEfGhIjKlMnOpQrStUv', { cwd }).text,
    'Claude-Session: https://claude.ai/code/session_00000000000000000000000000',
  );
  assert.equal(redact('session_abc', { cwd }).text, 'session_abc');
});

// --- Round 2 ---------------------------------------------------------------

test('round 2 item 1: a bare -Users-<name>/-home-<name> encoding (no trailing dash) is also rewritten', () => {
  assert.equal(
    redact('cat ~/.claude/projects/-Users-alice', { cwd }).text,
    'cat ~/.claude/projects/-Users-~',
  );
  assert.equal(
    redact('cat ~/.claude/projects/-Users-alice-projects-app/memory/x.md', { cwd }).text,
    'cat ~/.claude/projects/-Users-~-projects-app/memory/x.md',
  );
  assert.equal(redact('echo -Users-', { cwd }).text, 'echo -Users-');
  assert.equal(redact('cat ~/.claude/projects/-Users-~', { cwd }).text, 'cat ~/.claude/projects/-Users-~');   // idempotent
});

test('T3: smbclient -U user%pass and --user=user%pass drop the vector; -U without a % is not a credential', () => {
  for (const c of ['smbclient -U me%pw //host/share', 'smbclient --user=me%pw -L host', 'smbclient -Ume%pw //host/share']) assert.equal(redact(c, { cwd }).dropped, 'secret', c);
  assert.equal(redact('grep -U pattern file', { cwd }).dropped, null);
  assert.equal(redact('mysql -u root -p', { cwd }).dropped, null);   // a bare -p carries no secret
});

test('T3: the cwd substitution also stops at : ; and ,', () => {
  assert.equal(redact('PATH=/Users/alice/projects/app:/bin ls', { cwd }).text, 'PATH=.:/bin ls');
  assert.equal(redact('cd /Users/alice/projects/app; ls', { cwd }).text, 'cd .; ls');
  assert.equal(redact('echo /Users/alice/projects/app,/tmp', { cwd }).text, 'echo .,/tmp');
});

test('T4: Windows home directories are scrubbed to ~ in either slash direction; a drive path without a user is untouched', () => {
  assert.equal(redact('type C:\\Users\\alice\\proj\\a.ts', { cwd }).text, 'type ~\\proj\\a.ts');
  assert.equal(redact('cat C:/Users/alice/proj/a.ts', { cwd }).text, 'cat ~/proj/a.ts');
  assert.equal(redact('dir D:\\work\\x', { cwd }).text, 'dir D:\\work\\x');
});
