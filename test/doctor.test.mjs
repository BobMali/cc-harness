import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { diagnose, formatStatus, ruleStamp, RULE_NAMES } from '../plugins/cc-harness/lib/doctor.mjs';
import { loadConfig } from '../plugins/cc-harness/lib/config.mjs';
import { makeProject } from './helpers/project.mjs';
import { syncCi } from '../plugins/cc-harness/lib/init.mjs';

const REGEX = '^(feat|fix)(\\((cli)\\))?!?: [a-z].{0,64}[^.]$\n# types: feat fix\n# scopes: cli\n';
const rules = Object.fromEntries(RULE_NAMES.map((n) => [`.claude/rules/harness-${n}.md`, '<!-- cc-harness: v0.1.0 -->\n# x\n']));
const config = { version: 1, project: { markerFile: 'package.json', sourceGlobs: ['**/*.ts'], testGlobs: ['**/*.test.ts'] }, checks: [{ name: 'tc', cmd: 'true', ifExists: 'tsconfig.json', fast: true }, { name: 'test', cmd: 'true' }], guards: { stop: { checks: ['test'] } } };
const gitOk = (cmd) => (cmd.includes('core.hooksPath') ? { status: 0, output: 'githooks\n' } : { status: 0, output: 'git version 2.40\n' });

function report(p, { exec = gitOk, nodeVersion = 'v22.0.0' } = {}) {
  return diagnose({ projectDir: p.dir, loaded: loadConfig(p.dir), exec, fs, pluginVersion: '0.1.0', nodeVersion });
}

test('healthy project → no warnings or errors', () => {
  const p = makeProject({ config, marker: 'package.json', files: { 'githooks/conventional-regex.txt': REGEX, 'githooks/commit-msg': '#!/bin/sh\n', ...rules } });
  try {
    const r = report(p);
    assert.deepEqual(r.findings.filter((f) => f.level !== 'ok'), []);
    const s = formatStatus(r, { pluginVersion: '0.1.0', config: loadConfig(p.dir).config });
    assert.match(s, /^cc-harness v0\.1\.0 · preset custom · guards: test commit quality git stop preflight/m);
    assert.match(s, /checks: tc\* test \(skipped: tc, missing tsconfig\.json\)/);
    assert.match(s, /stop gate: test/);
    assert.equal(s.split('\n').filter(Boolean).length, 5);
  } finally { p.cleanup(); }
});

test('problems are reported one per finding', () => {
  const p = makeProject({ config: { ...config, version: 1 }, files: { '.claude/rules/harness-testing.md': '<!-- cc-harness: v0.0.9 -->\n' } });
  try {
    const r = report(p, { exec: (cmd) => (cmd.includes('core.hooksPath') ? { status: 1, output: '' } : { status: 0, output: 'git version 2\n' }), nodeVersion: 'v16.0.0' });
    const texts = r.findings.filter((f) => f.level !== 'ok').map((f) => f.text).join('\n');
    assert.match(texts, /node v16.*18/i);
    assert.match(texts, /package\.json.*not found/);
    assert.match(texts, /conventional-regex\.txt.*not found/);
    assert.match(texts, /core\.hooksPath/);
    assert.match(texts, /harness-testing\.md.*v0\.0\.9.*0\.1\.0/);
    assert.match(texts, /harness-done\.md.*missing/);
  } finally { p.cleanup(); }
});

test('invalid config is a single error finding', () => {
  const p = makeProject({ files: { '.claude/harness.json': '{"version": 3}' } });
  try {
    const r = report(p);
    assert.equal(r.findings.filter((f) => f.level === 'error').length, 1);
    assert.match(r.findings.find((f) => f.level === 'error').text, /version must be 1/);
  } finally { p.cleanup(); }
});

test('ruleStamp', () => {
  assert.equal(ruleStamp('<!-- cc-harness: v0.1.0 -->\nhi'), '0.1.0');
  assert.equal(ruleStamp('# no stamp'), null);
});

test('item7: ruleStamp strips a leading BOM and only reads line 1', () => {
  assert.equal(ruleStamp('\uFEFF<!-- cc-harness: v0.1.0 -->\nhi'), '0.1.0');
  assert.equal(ruleStamp('# preamble\n<!-- cc-harness: v0.1.0 -->\nhi'), null);
});

test('item7: hooksPath comparison resolves relative and absolute git output against projectDir', () => {
  const p = makeProject({ config, marker: 'package.json', files: { 'githooks/conventional-regex.txt': REGEX, 'githooks/commit-msg': '#!/bin/sh\n', ...rules } });
  try {
    for (const output of ['./githooks\n', `${p.dir}/githooks\n`]) {
      const exec = (cmd) => (cmd.includes('core.hooksPath') ? { status: 0, output } : { status: 0, output: 'git version 2.40\n' });
      const r = report(p, { exec });
      assert.deepEqual(r.findings.filter((f) => f.level !== 'ok'), [], output);
    }
  } finally { p.cleanup(); }
});

test('T3: a stale workflow and owned entries missing from settings are warnings; a synced workflow is current', () => {
  const owned = JSON.stringify({ version: 1, permissions: { allow: ['Bash(tc:*)', 'Bash(git status:*)'], ask: [], deny: [] } });
  const p = makeProject({ config, marker: 'package.json', files: { 'githooks/conventional-regex.txt': REGEX, 'githooks/commit-msg': '#!/bin/sh\n', ...rules, '.github/workflows/harness.yml': 'stale', '.claude/harness.owned.json': owned, '.claude/settings.json': JSON.stringify({ permissions: { allow: ['Bash(git status:*)'] } }) } });
  try {
    let texts = report(p).findings.filter((f) => f.level === 'warn').map((f) => f.text).join('\n');
    assert.match(texts, /\.github\/workflows\/harness\.yml differs from what \.claude\/harness\.json renders; run harness sync-ci/);
    assert.match(texts, /1 harness-owned permission entr.* missing from \.claude\/settings\.json/);
    assert.equal(syncCi({ targetDir: p.dir, pluginVersion: '0.1.0' }, { stdout: { write() {} }, stderr: { write() {} } }), 0);
    texts = report(p).findings.map((f) => `${f.level} ${f.text}`).join('\n');
    assert.match(texts, /ok \.github\/workflows\/harness\.yml current/);
    assert.doesNotMatch(texts, /warn .*harness\.yml/);
  } finally { p.cleanup(); }
});

test('T4: doctor reports the shell, and an error on win32 when no sh.exe can be found', () => {
  const p = makeProject({ config, marker: 'package.json', files: { 'githooks/conventional-regex.txt': REGEX, 'githooks/commit-msg': '#!/bin/sh\n', ...rules } });
  try {
    const here = diagnose({ projectDir: p.dir, loaded: loadConfig(p.dir), exec: gitOk, fs, pluginVersion: '0.1.0', nodeVersion: 'v22.0.0', platform: 'darwin', env: {} });
    assert.ok(here.findings.some((f) => f.level === 'ok' && f.text === 'shell /bin/sh'));
    const win = diagnose({ projectDir: p.dir, loaded: loadConfig(p.dir), exec: gitOk, fs, pluginVersion: '0.1.0', nodeVersion: 'v22.0.0', platform: 'win32', env: { PATH: 'C:\\nothing' } });
    assert.ok(win.findings.some((f) => f.level === 'error' && /no POSIX shell found/.test(f.text)));
  } finally { p.cleanup(); }
});
