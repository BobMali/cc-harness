import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { render, deepMergeSettings, buildRegex, templateVars, templatesDir } from '../plugins/cc-harness/lib/render.mjs';
import { DEFAULTS, mergeConfig, loadPreset } from '../plugins/cc-harness/lib/config.mjs';

function walkTmpl(dir) {
  let out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out = out.concat(walkTmpl(p));
    else if (entry.name.endsWith('.tmpl')) out.push(p);
  }
  return out;
}

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

test('one-liner: deepMergeSettings treats an existing null as absent so the fragment wins', () => {
  assert.deepEqual(
    deepMergeSettings({ permissions: null }, { permissions: { allow: ['x'] } }),
    { permissions: { allow: ['x'] } },
  );
});

test('buildRegex with and without scopes', () => {
  assert.equal(buildRegex(['feat', 'fix'], ['cli']), '^(feat|fix)(\\((cli)\\))?!?: [a-z](.{0,64}[^.])?$');
  assert.equal(buildRegex(['feat'], []), '^(feat)(\\([a-z0-9-]+\\))?!?: [a-z](.{0,64}[^.])?$');
  assert.match('feat(cli): add x', new RegExp(buildRegex(['feat'], ['cli'])));
  assert.doesNotMatch('feat(cli): Add x.', new RegExp(buildRegex(['feat'], ['cli'])));
});

test('F3: buildRegex escapes regex metacharacters in types and scopes, and rejects an empty type list', () => {
  const re = new RegExp(buildRegex(['feat'], ['api.v2']));
  assert.match('feat(api.v2): x', re);
  assert.doesNotMatch('feat(apixv2): x', re);

  const re2 = new RegExp(buildRegex(['c++'], []));
  assert.match('c++: x', re2);

  assert.throws(() => buildRegex([], []), /at least one commit type/);
});

test('F4: templateVars covers every placeholder actually used by the shipped .tmpl files', () => {
  const preset = loadPreset('ts');
  const config = mergeConfig(DEFAULTS, preset);
  const v = templateVars({ config, preset, types: ['feat', 'fix'], scopes: [], pluginVersion: '0.1.0', projectName: 'demo' });

  const placeholderRe = /\{\{([A-Z0-9_]+)\}\}/g;
  const unfilledRe = /\{\{[A-Z0-9_]+\}\}/;
  const files = walkTmpl(templatesDir());
  assert.ok(files.length >= 7, `expected at least 7 .tmpl files, found ${files.length}`);
  for (const f of files) {
    const rel = path.relative(templatesDir(), f);
    const text = fs.readFileSync(f, 'utf8');
    const keys = new Set();
    let m;
    while ((m = placeholderRe.exec(text))) keys.add(m[1]);
    for (const k of keys) assert.equal(typeof v[k], 'string', `${rel} needs ${k}`);
    assert.doesNotMatch(render(text, v), unfilledRe, rel);
  }

  assert.equal(v.COMMIT_SCOPES_LINE, 'any lower-case word, e.g. `feat(api): ...`');
  assert.match(v.CI_SETUP_STEPS, /actions\/setup-node@v4/);
  assert.match(v.CI_CHECK_STEPS, /- name: typecheck\n\s+run: .*tsc --noEmit/);
  assert.match(v.CI_CHECK_STEPS, /\[ -e "tsconfig\.json" \] \|\| exit 0/);
  assert.match(v.TRAILER_RULE, /Co-Authored-By/);
  assert.equal(templateVars({ config: mergeConfig(config, { guards: { commit: { rejectAttributionTrailers: false } } }), preset, types: ['feat'], scopes: [], pluginVersion: '0.1.0', projectName: 'd' }).TRAILER_RULE, '');
});

test('F4: ci.yml.tmpl renders with the GitHub expression intact and a real check step', () => {
  const preset = loadPreset('ts');
  const config = mergeConfig(DEFAULTS, preset);
  const v = templateVars({ config, preset, types: ['feat'], scopes: [], pluginVersion: '0.1.0', projectName: 'd' });
  const text = fs.readFileSync(path.join(templatesDir(), 'ci.yml.tmpl'), 'utf8');
  const rendered = render(text, v);
  assert.match(rendered, /\$\{\{ github\.base_ref \}\}/);
  assert.match(rendered, /- name: typecheck/);
});

test('F2: FAST_CHECKS follows the quality scope and both gates report when disabled', () => {
  const preset = loadPreset('ts');
  const config = mergeConfig(DEFAULTS, preset);
  const base = { preset, types: ['feat'], scopes: [], pluginVersion: '0.1.0', projectName: 'd' };

  const allScope = templateVars({ ...base, config: mergeConfig(config, { guards: { quality: { scope: 'all' } } }) });
  assert.match(allScope.FAST_CHECKS, /\btest\b/);

  const qualityDisabled = templateVars({ ...base, config: mergeConfig(config, { guards: { quality: { enabled: false } } }) });
  assert.equal(qualityDisabled.FAST_CHECKS, '(quality gate disabled)');

  const stopDisabled = templateVars({ ...base, config: mergeConfig(config, { guards: { stop: { enabled: false } } }) });
  assert.equal(stopDisabled.STOP_CHECKS, '(stop gate disabled)');
});

test('CI steps come from config.ci, so a custom config can declare setup and extra steps', () => {
  const config = mergeConfig(DEFAULTS, {
    preset: 'custom',
    checks: [{ name: 'tests', cmd: 'node --test test/*.test.mjs' }],
    ci: {
      setupSteps: [{ uses: 'actions/setup-node@v4', with: { 'node-version': '20' } }, { run: 'npm install -g @anthropic-ai/claude-code' }],
      extraSteps: [{ name: 'sampled evals', run: 'node evals/run.mjs --via cli --sample 100 --json evals/results.json' }, { uses: 'actions/upload-artifact@v4', if: 'always()', with: { name: 'eval-results', path: 'evals/results.json' } }],
    },
  });
  const v = templateVars({ config, types: ['feat'], scopes: [], pluginVersion: '0.1.0', projectName: 'd' });
  assert.match(v.CI_SETUP_STEPS, /- uses: actions\/setup-node@v4\n\s+with:\n\s+node-version: "20"/);
  assert.match(v.CI_SETUP_STEPS, /- run: 'npm install -g @anthropic-ai\/claude-code'/);
  assert.match(v.CI_EXTRA_STEPS, /- name: sampled evals\n\s+run: 'node evals\/run\.mjs --via cli/);
  assert.match(v.CI_EXTRA_STEPS, /- uses: actions\/upload-artifact@v4\n\s+if: always\(\)\n\s+with:/);
  const rendered = render(fs.readFileSync(path.join(templatesDir(), 'ci.yml.tmpl'), 'utf8'), v);
  assert.ok(rendered.indexOf('- name: tests') < rendered.indexOf('- name: sampled evals'), 'extra steps render after the check steps');
  // a config without a ci block renders empty step lists, not placeholders
  const bare = templateVars({ config: mergeConfig(DEFAULTS, { preset: 'custom' }), types: ['feat'], scopes: [], pluginVersion: '0.1.0', projectName: 'd' });
  assert.equal(bare.CI_SETUP_STEPS, ''); assert.equal(bare.CI_EXTRA_STEPS, '');
});
