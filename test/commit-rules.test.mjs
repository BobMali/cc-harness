import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRegexFile, extractCommitMessage, checkMessage } from '../plugins/cc-harness/lib/commit-rules.mjs';
import { splitSegments, tokenize } from '../plugins/cc-harness/lib/shell.mjs';

const FILE = `^(feat|fix|docs)(\\((cli|guards)\\))?!?: [a-z](.{0,64}[^.])?$
# types: feat fix docs
# scopes: cli guards
`;

test('parseRegexFile reads line 1 and the comment lines', () => {
  const r = parseRegexFile(FILE);
  assert.ok(r.regex instanceof RegExp);
  assert.deepEqual(r.types, ['feat', 'fix', 'docs']);
  assert.deepEqual(r.scopes, ['cli', 'guards']);
  assert.deepEqual(parseRegexFile('^x$\n').types, []);
  assert.equal(parseRegexFile('').regex, null);
  assert.match(parseRegexFile('(').error, /invalid/i);
});

function extract(cmd) {
  const seg = splitSegments(cmd).find((s) => /\bgit\b.*\bcommit\b/.test(s));
  return extractCommitMessage(cmd, seg, tokenize(seg), () => { throw new Error('no file'); });
}

test('extractCommitMessage handles -m, multiple -m, --message=, -F file, heredoc, and none', () => {
  assert.equal(extract('git commit -m "feat: add x"'), 'feat: add x');
  assert.equal(extract("git commit -m 'feat: add x' -m 'body here'"), 'feat: add x\n\nbody here');
  assert.equal(extract('git commit --message="fix: y"'), 'fix: y');
  assert.equal(extract('git commit -am "fix: y"'), 'fix: y');
  assert.equal(extract('git commit -F - <<\'EOF\'\nfeat: z\n\nbody\nEOF'), 'feat: z\n\nbody');
  assert.equal(extract('git commit -F - <<EOF\nfeat: z\nEOF'), 'feat: z');
  assert.equal(extract('git commit --amend --no-edit'), null);
  assert.equal(extract('git commit'), null);
  const seg = 'git commit -F msg.txt';
  assert.equal(extractCommitMessage(seg, seg, tokenize(seg), (f) => (f === 'msg.txt' ? 'docs: from file\n' : null)), 'docs: from file');
});

test('checkMessage validates subject and trailers', () => {
  const rules = parseRegexFile(FILE);
  assert.deepEqual(checkMessage('feat(cli): add thing', rules, { rejectAttributionTrailers: true }), []);
  assert.match(checkMessage('update code', rules, { rejectAttributionTrailers: true })[0], /subject/);
  assert.match(checkMessage('feat: Add thing.', rules, { rejectAttributionTrailers: true })[0], /subject/);
  assert.match(checkMessage('feat: ok\n\nCo-Authored-By: X <x@y>', rules, { rejectAttributionTrailers: true })[0], /attribution/);
  assert.match(checkMessage('feat: ok\n\nClaude-Session: https://x', rules, { rejectAttributionTrailers: true })[0], /attribution/);
  assert.match(checkMessage('feat: ok\n\n🤖 Generated with [Claude Code](https://claude.com)', rules, { rejectAttributionTrailers: true })[0], /attribution/);
  assert.deepEqual(checkMessage('feat: ok\n\nCo-Authored-By: X <x@y>', rules, { rejectAttributionTrailers: false }), []);
  assert.match(checkMessage('feat: ok', { regex: null, types: [], scopes: [], error: 'x' }, {})[0], /regex file/);
});
