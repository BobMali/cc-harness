import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from '../plugins/cc-harness/lib/render.mjs';
import { makeProject } from './helpers/project.mjs';

const TEMPLATE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'cc-harness', 'templates', 'githooks', 'commit-msg.tmpl');
const TEMPLATE_SRC = fs.readFileSync(TEMPLATE, 'utf8');
const REGEX = '^(feat|fix)(\\((cli)\\))?!?: [a-z](.{0,64}[^.])?$\n# types: feat fix\n# scopes: cli\n';

// Renders the template (defaulting to the shipped regex path and reject-trailers-on)
// into the project's githooks/commit-msg, executable, the way applyWrites does.
function installHook(p, vars = {}) {
  const content = render(TEMPLATE_SRC, { COMMIT_REGEX_FILE: 'githooks/conventional-regex.txt', REJECT_TRAILERS: '1', ...vars });
  return p.write('githooks/commit-msg', content, 0o755);
}

function runHook(p, message, env = {}, vars = {}) {
  const hook = installHook(p, vars);
  const f = p.write('.git/COMMIT_EDITMSG', message);
  return spawnSync('/bin/sh', [hook, f], { cwd: p.dir, encoding: 'utf8', env: { ...process.env, ...env } });
}

test('commit-msg hook accepts and rejects like the guard', () => {
  const p = makeProject({ files: { 'githooks/conventional-regex.txt': REGEX } });
  try {
    spawnSync('git', ['init', '-q'], { cwd: p.dir });
    assert.equal(runHook(p, 'feat(cli): add x\n').status, 0);
    assert.equal(runHook(p, '# comment line\nfix: y\n').status, 0);
    const bad = runHook(p, 'update code\n');
    assert.equal(bad.status, 1); assert.match(bad.stderr, /types:  feat fix/);
    const trailer = runHook(p, 'feat: ok\n\nCo-Authored-By: x <x@y>\n');
    assert.equal(trailer.status, 1); assert.match(trailer.stderr, /attribution/);
    assert.equal(runHook(p, 'feat: ok\n\nCo-Authored-By: x <x@y>\n', { CC_HARNESS_REJECT_TRAILERS: '0' }).status, 0);
  } finally { p.cleanup(); }
});

test('REJECT_TRAILERS=0 rendered into the hook accepts a trailer without setting the env var', () => {
  const p = makeProject({ files: { 'githooks/conventional-regex.txt': REGEX } });
  try {
    spawnSync('git', ['init', '-q'], { cwd: p.dir });
    const r = runHook(p, 'feat: ok\n\nCo-Authored-By: x <x@y>\n', {}, { REJECT_TRAILERS: '0' });
    assert.equal(r.status, 0);
  } finally { p.cleanup(); }
});

test('a custom COMMIT_REGEX_FILE is rendered into the hook and honoured', () => {
  const p = makeProject({ files: { 'githooks/custom-regex.txt': REGEX } });
  try {
    spawnSync('git', ['init', '-q'], { cwd: p.dir });
    const r = runHook(p, 'feat(cli): add x\n', {}, { COMMIT_REGEX_FILE: 'githooks/custom-regex.txt' });
    assert.equal(r.status, 0);
  } finally { p.cleanup(); }
});

test('the scopes hint still prints when there is no "# types:" line (set -e cosmetic fix)', () => {
  const p = makeProject({ files: { 'githooks/conventional-regex.txt': '^(feat)(\\((cli)\\))?!?: [a-z](.{0,64}[^.])?$\n# scopes: cli\n' } });
  try {
    spawnSync('git', ['init', '-q'], { cwd: p.dir });
    const r = runHook(p, 'update code\n');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /scopes: cli/);
  } finally { p.cleanup(); }
});

test('F5: an empty regex line on line 1 fails closed instead of matching everything', () => {
  const p = makeProject({ files: { 'githooks/conventional-regex.txt': '\n# types: feat fix\n' } });
  try {
    spawnSync('git', ['init', '-q'], { cwd: p.dir });
    const r = runHook(p, 'total garbage\n');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no regex on line 1/);
  } finally { p.cleanup(); }
});

test('hygiene: a trailing \\r on the subject/regex does not mask a real mismatch', () => {
  const p = makeProject({ files: { 'githooks/conventional-regex.txt': REGEX } });
  try {
    spawnSync('git', ['init', '-q'], { cwd: p.dir });
    assert.equal(runHook(p, 'feat: ok\r\n').status, 0);
    assert.equal(runHook(p, 'feat: ok.\r\n').status, 1);
  } finally { p.cleanup(); }
});

test('under git with core.hooksPath the hook blocks a real commit', () => {
  const p = makeProject({ files: { 'githooks/conventional-regex.txt': REGEX, 'a.txt': 'a' } });
  try {
    const hookPath = installHook(p);
    assert.ok(fs.statSync(hookPath).mode & 0o111, 'rendered hook must be executable');
    const git = (...a) => spawnSync('git', a, { cwd: p.dir, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
    git('init', '-q'); git('config', 'core.hooksPath', 'githooks'); git('add', '.');
    const bad = git('commit', '-q', '-m', 'bad message');
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /does not match the required format/);
    assert.equal(git('commit', '-q', '-m', 'feat: good message').status, 0);
  } finally { p.cleanup(); }
});
