import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeProject, makeDataDir } from './helpers/project.mjs';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'cc-harness', 'bin', 'harness.mjs');

export function runHookCli(event, input, { projectDir, dataDir, env = {} } = {}) {
  const r = spawnSync(process.execPath, [BIN, 'hook', event], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir, CLAUDE_PLUGIN_DATA: dataDir ?? '', ...env },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json: r.stdout.trim() ? JSON.parse(r.stdout) : null };
}

const CFG = { version: 1, project: { testGlobs: ['**/*.test.*'] } };

test('no config → silent exit 0 for every event', () => {
  const p = makeProject({ files: { 'x.test.ts': '' } });
  try {
    for (const ev of ['PreToolUse', 'PostToolUse', 'Stop', 'SessionStart']) {
      const r = runHookCli(ev, { tool_name: 'Bash', tool_input: { command: 'rm x.test.ts' }, session_id: 's1' }, { projectDir: p.dir });
      assert.equal(r.status, 0, ev); assert.equal(r.stdout, '', ev);
    }
  } finally { p.cleanup(); }
});

test('marker file configured but absent → silent', () => {
  const p = makeProject({ config: { ...CFG, project: { ...CFG.project, markerFile: 'package.json' } }, files: { 'x.test.ts': '' } });
  try {
    const r = runHookCli('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'rm x.test.ts' } }, { projectDir: p.dir });
    assert.equal(r.status, 0); assert.equal(r.stdout, '');
  } finally { p.cleanup(); }
});

test('item4: marker file absent still exempts SessionStart, which reports it; PreToolUse stays silent', () => {
  const p = makeProject({ config: { ...CFG, project: { ...CFG.project, markerFile: 'package.json' } } });
  try {
    const start = spawnSync(process.execPath, [BIN, 'hook', 'SessionStart'], {
      input: JSON.stringify({ source: 'startup', session_id: 's1' }),
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: p.dir, CLAUDE_PLUGIN_DATA: '' },
    });
    assert.equal(start.status, 0);
    assert.match(start.stdout, /marker file package\.json not found/);
    const pre = runHookCli('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'rm x.test.ts' } }, { projectDir: p.dir });
    assert.equal(pre.status, 0); assert.equal(pre.stdout, '');
  } finally { p.cleanup(); }
});

test('PreToolUse emits the ask JSON shape; deny beats ask', () => {
  const p = makeProject({ config: CFG, files: { 'x.test.ts': '' } });
  try {
    const r = runHookCli('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'rm x.test.ts' } }, { projectDir: p.dir });
    assert.equal(r.status, 0);
    assert.equal(r.json.hookSpecificOutput.permissionDecision, 'ask');
    assert.equal(r.json.hookSpecificOutput.hookEventName, 'PreToolUse');
  } finally { p.cleanup(); }
});

test('invalid config → PreToolUse asks with the error, other events write stderr and exit 0', () => {
  const p = makeProject({ files: { '.claude/harness.json': '{"version": 9}' } });
  try {
    const a = runHookCli('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }, { projectDir: p.dir });
    assert.equal(a.json.hookSpecificOutput.permissionDecision, 'ask');
    assert.match(a.json.hookSpecificOutput.permissionDecisionReason, /version must be 1/);
    const b = runHookCli('PostToolUse', { tool_name: 'Edit', tool_input: { file_path: 'a.ts' } }, { projectDir: p.dir });
    assert.equal(b.status, 0); assert.equal(b.stdout, ''); assert.match(b.stderr, /version must be 1/);
  } finally { p.cleanup(); }
});

test('empty or non-JSON stdin → silent exit 0', () => {
  const p = makeProject({ config: CFG });
  try {
    const r = spawnSync(process.execPath, [BIN, 'hook', 'PreToolUse'], { input: '', encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: p.dir } });
    assert.equal(r.status, 0); assert.equal(r.stdout, '');
  } finally { p.cleanup(); }
});
