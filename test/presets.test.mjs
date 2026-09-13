import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULTS, mergeConfig, validateConfig, defaultPresetsDir, loadPreset } from '../plugins/cc-harness/lib/config.mjs';
import { templatesDir } from '../plugins/cc-harness/lib/render.mjs';
import { RULE_NAMES } from '../plugins/cc-harness/lib/doctor.mjs';

test('every shipped preset merges into a valid config', () => {
  for (const f of fs.readdirSync(defaultPresetsDir()).filter((x) => x.endsWith('.json'))) {
    const preset = loadPreset(f.replace(/\.json$/, ''));
    assert.deepEqual(validateConfig(mergeConfig(DEFAULTS, preset)), [], f);
  }
});

test('ts preset facts the docs rely on', () => {
  const c = mergeConfig(DEFAULTS, loadPreset('ts'));
  assert.equal(c.project.markerFile, 'package.json');
  assert.ok(c.checks.every((ch) => !ch.cmd.startsWith('npx')));
  assert.deepEqual(c.guards.stop.checks, ['typecheck', 'test', 'test-jest']);
});

test('every rules template starts with the version stamp line', () => {
  for (const n of RULE_NAMES) {
    const t = fs.readFileSync(path.join(templatesDir(), 'rules', `harness-${n}.md.tmpl`), 'utf8');
    assert.ok(t.startsWith('<!-- cc-harness: v{{HARNESS_VERSION}} -->\n'), n);
  }
  assert.ok(fs.existsSync(path.join(templatesDir(), 'CLAUDE.md.tmpl')));
  assert.ok(fs.existsSync(path.join(templatesDir(), 'ci.yml.tmpl')));
  assert.ok(fs.existsSync(path.join(templatesDir(), 'githooks', 'commit-msg')));
});
