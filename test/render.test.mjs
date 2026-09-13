import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, deepMergeSettings, buildRegex, templateVars } from '../plugins/cc-harness/lib/render.mjs';
import { DEFAULTS, mergeConfig, loadPreset } from '../plugins/cc-harness/lib/config.mjs';

test('render substitutes known keys and leaves unknown ones and GitHub expressions alone', () => {
  assert.equal(render('a {{X}} b {{Y}} ${{ github.base_ref }}', { X: '1' }), 'a 1 b {{Y}} ${{ github.base_ref }}');
  assert.equal(render('{{X}}{{X}}', { X: 'a/b&c' }), 'a/b&ca/b&c');
});

test('deepMergeSettings: existing scalars win, arrays union, objects recurse', () => {
  const out = deepMergeSettings(
    { permissions: { allow: ['Bash(a:*)'], defaultMode: 'plan' }, model: 'x' },
    { permissions: { allow: ['Bash(b:*)', 'Bash(a:*)'], ask: ['Bash(rm:*)'], defaultMode: 'acceptEdits' }, enabledPlugins: { 'cc-harness@cc-harness': true } },
  );
  assert.deepEqual(out, {
    permissions: { allow: ['Bash(a:*)', 'Bash(b:*)'], defaultMode: 'plan', ask: ['Bash(rm:*)'] },
    model: 'x',
    enabledPlugins: { 'cc-harness@cc-harness': true },
  });
});

test('buildRegex with and without scopes', () => {
  assert.equal(buildRegex(['feat', 'fix'], ['cli']), '^(feat|fix)(\\((cli)\\))?!?: [a-z](.{0,64}[^.])?$');
  assert.equal(buildRegex(['feat'], []), '^(feat)(\\([a-z0-9-]+\\))?!?: [a-z](.{0,64}[^.])?$');
  assert.match('feat(cli): add x', new RegExp(buildRegex(['feat'], ['cli'])));
  assert.doesNotMatch('feat(cli): Add x.', new RegExp(buildRegex(['feat'], ['cli'])));
});

test('templateVars covers every template key', () => {
  const preset = loadPreset('ts');
  const config = mergeConfig(DEFAULTS, preset);
  const v = templateVars({ config, preset, types: ['feat', 'fix'], scopes: [], pluginVersion: '0.1.0', projectName: 'demo' });
  for (const k of ['PROJECT_NAME', 'PRESET', 'HARNESS_VERSION', 'COMMANDS', 'TEST_GLOBS', 'STOP_CHECKS', 'FAST_CHECKS', 'COMMIT_TYPES', 'COMMIT_SCOPES', 'COMMIT_SCOPES_LINE', 'COMMIT_REGEX', 'COMMIT_REGEX_FILE', 'TRAILER_RULE', 'GUARDS', 'CI_SETUP_STEPS', 'CI_CHECK_STEPS']) {
    assert.equal(typeof v[k], 'string', k);
  }
  assert.equal(v.COMMIT_SCOPES_LINE, 'any lower-case word, e.g. `feat(api): ...`');
  assert.match(v.CI_SETUP_STEPS, /actions\/setup-node@v4/);
  assert.match(v.CI_CHECK_STEPS, /- name: typecheck\n\s+run: .*tsc --noEmit/);
  assert.match(v.CI_CHECK_STEPS, /\[ -e "tsconfig\.json" \] \|\| exit 0/);
  assert.match(v.TRAILER_RULE, /Co-Authored-By/);
  assert.equal(templateVars({ config: mergeConfig(config, { guards: { commit: { rejectAttributionTrailers: false } } }), preset, types: ['feat'], scopes: [], pluginVersion: '0.1.0', projectName: 'd' }).TRAILER_RULE, '');
});
