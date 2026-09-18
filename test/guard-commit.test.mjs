import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../plugins/cc-harness/lib/guards/commit.mjs';
import { DEFAULTS, mergeConfig } from '../plugins/cc-harness/lib/config.mjs';
import { makeProject } from './helpers/project.mjs';

const REGEX = '^(feat|fix|docs)(\\((cli|guards)\\))?!?: [a-z](.{0,64}[^.])?$\n# types: feat fix docs\n# scopes: cli guards\n';
const files = { 'githooks/conventional-regex.txt': REGEX, 'msg.txt': 'feat: from file\n' };

function run(p, command, over = {}) {
  const config = mergeConfig(DEFAULTS, over);
  return evaluate({ event: 'PreToolUse', input: { tool_name: 'Bash', tool_input: { command } }, config, projectDir: p.dir });
}

test('valid commits pass', () => {
  const p = makeProject({ files });
  try {
    for (const c of ['git commit -m "feat: add x"', "git commit -am 'fix(cli): y'", 'git commit -F msg.txt', 'git commit --amend --no-edit', 'git commit', 'git status', 'echo git commit -m "bad"', 'git commit -F - <<\'EOF\'\nfeat(guards): z\nEOF', 'git commit -m "$(cat <<\'EOF\'\nfeat: ok\nEOF\n)"']) {
      assert.equal(run(p, c), null, c);
    }
  } finally { p.cleanup(); }
});

test('invalid commits deny with the format hint', () => {
  const p = makeProject({ files });
  try {
    const d = run(p, 'git commit -m "update code"');
    assert.equal(d?.kind, 'deny');
    assert.match(d.reason, /allowed types: feat fix docs/);
    assert.equal(run(p, 'git add . && git commit -m "Feat: caps"')?.kind, 'deny');
    assert.equal(run(p, 'git commit -m "feat: ok" -m "Co-Authored-By: bot <b@x>"')?.kind, 'deny');
    assert.equal(run(p, 'git commit -F - <<EOF\nfeat: ok\n\nClaude-Session: https://x\nEOF')?.kind, 'deny');
    assert.equal(run(p, 'git commit -m "feat: ok" -m "Co-Authored-By: bot <b@x>"', { guards: { commit: { rejectAttributionTrailers: false } } }), null);
    // F1: -C <dir> and -c k=v must not be mistaken for the subcommand
    assert.equal(run(p, 'git -C sub commit -m "bad message"')?.kind, 'deny');
    assert.equal(run(p, 'git -c user.name=x commit -m "bad message"')?.kind, 'deny');
    // F3: attached -m"value" form
    assert.equal(run(p, 'git commit -m"bad message"')?.kind, 'deny');
    // F4: the $(cat <<EOF ... EOF) idiom, once expanded, still validates the resulting message
    assert.equal(run(p, 'git commit -m "$(cat <<\'EOF\'\nbad message\nEOF\n)"')?.kind, 'deny');
    // F5: --git-dir <dir> (space form) must not be mistaken for the subcommand
    assert.equal(run(p, 'git --git-dir .git commit -m "bad message"')?.kind, 'deny');
  } finally { p.cleanup(); }
});

test('missing regex file denies with a pointer', () => {
  const p = makeProject({ files: {} });
  try {
    const d = run(p, 'git commit -m "feat: x"');
    assert.equal(d?.kind, 'deny');
    assert.match(d.reason, /githooks\/conventional-regex\.txt/);
  } finally { p.cleanup(); }
});

test('a commit inside a sh -c body is checked too', () => {
  const p = makeProject({ files });
  try {
    assert.equal(run(p, `bash -c 'git commit -m "bad message"'`)?.kind, 'deny');
    assert.equal(run(p, `sh -c 'git add . && git commit -m "feat: ok"'`), null);
  } finally { p.cleanup(); }
});
