import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../plugins/cc-harness/lib/guards/git.mjs';
import { DEFAULTS } from '../plugins/cc-harness/lib/config.mjs';

const bash = (command) => evaluate({ event: 'PreToolUse', input: { tool_name: 'Bash', tool_input: { command } }, config: DEFAULTS, projectDir: '/p' });

test('destructive git commands ask', () => {
  for (const c of [
    'git reset --hard', 'git reset --hard HEAD~1', 'git checkout .', 'git checkout -- src/a.ts', 'git restore .',
    'git clean -f', 'git clean -fdx', 'git push --force', 'git push -f origin main', 'git branch -D feature',
    'git stash drop', 'git stash clear', 'git -C /x push -f', 'cd /x && git reset --hard',
    'git --git-dir /tmp/x reset --hard', 'git --work-tree /tmp/x clean -fd',
    'git push origin +main', 'git branch -Df feature', 'git branch --delete --force feature',
    'git --attr-source HEAD reset --hard',
  ]) {
    const d = bash(c);
    assert.equal(d?.kind, 'ask', `expected ask for: ${c}`);
    assert.match(d.reason, /cc-harness git guard/);
  }
});

test('ordinary git commands pass', () => {
  for (const c of [
    'git status', 'git reset HEAD~1', 'git reset --soft HEAD~1', 'git checkout -b feature', 'git checkout main',
    'git restore --staged a.ts', 'git clean -n', 'git push', 'git push --force-with-lease', 'git branch -d merged',
    'git stash', 'git stash pop', 'git log --oneline', 'echo "git reset --hard"',
    'git push origin main', 'git branch --delete merged',
    // Inert: git has no space-form value for --exec-path, so a bare `--exec-path`
    // prints the current exec path and exits(0) before "reset --hard" ever runs
    // (verified against real git); the guard must not treat it as destructive.
    'git --exec-path reset --hard',
  ]) {
    assert.equal(bash(c), null, `expected pass for: ${c}`);
  }
});

test('non-Bash tools are ignored', () => {
  assert.equal(evaluate({ event: 'PreToolUse', input: { tool_name: 'Edit', tool_input: {} }, config: DEFAULTS, projectDir: '/p' }), null);
});

test('destructive git commands inside a sh -c body ask; near misses inside one pass', () => {
  for (const c of [
    'bash -c "git reset --hard"', "sh -c 'git push -f'", "bash -lc 'git clean -fd'",
    `bash -c 'sh -c "git reset --hard"'`, "sudo /bin/bash -c 'git stash clear'",
  ]) {
    const d = bash(c);
    assert.equal(d?.kind, 'ask', `expected ask for: ${c}`);
    assert.match(d.reason, /cc-harness git guard/);
  }
  for (const c of ['bash -c "echo git reset --hard"', "bash -c 'git status'", 'bash script.sh reset --hard']) {
    assert.equal(bash(c), null, `expected pass for: ${c}`);
  }
});

test('git push that deletes a remote ref asks; ordinary refspecs and branch -d pass', () => {
  for (const c of ['git push origin :feature', 'git push origin --delete feature', 'git push -d origin feature', 'git push --delete origin v1.0']) {
    const d = bash(c);
    assert.equal(d?.kind, 'ask', `expected ask for: ${c}`);
    assert.match(d.reason, /deletes a remote branch or tag/);
  }
  for (const c of ['git push origin HEAD:feature', 'git push origin main:main', 'git push origin :', 'git branch -d merged']) {
    assert.equal(bash(c), null, `expected pass for: ${c}`);
  }
});

test('prefix commands and eval do not hide a destructive git command', () => {
  for (const c of [
    'timeout 5 git reset --hard', 'nohup git push -f', 'sudo -u root git clean -fd', 'echo feature | xargs git branch -D',
    'eval "git reset --hard"', "eval 'git stash' 'clear'",
  ]) {
    const d = bash(c);
    assert.equal(d?.kind, 'ask', `expected ask for: ${c}`);
  }
  for (const c of ['timeout 5 echo git reset --hard', 'timeout 5 git status', 'eval "git status"']) {
    assert.equal(bash(c), null, `expected pass for: ${c}`);
  }
});

test('a variable or which-substitution standing in for git does not hide a destructive command', () => {
  for (const c of ['G=git; $G reset --hard', '$(which git) push -f', 'export G=git; eval "$G stash clear"', 'G="git reset --hard"; $G']) {
    assert.equal(bash(c)?.kind, 'ask', `expected ask for: ${c}`);
  }
  assert.equal(bash('G=git; $G status'), null);
});
