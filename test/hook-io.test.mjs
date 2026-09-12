import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readJson, ask, deny, block, context, warn, toHookJson, pickDecision } from '../plugins/cc-harness/lib/hook-io.mjs';
import { pluginRoot, pluginVersion } from '../plugins/cc-harness/lib/meta.mjs';

test('readJson parses stdin, tolerates empty and garbage', async () => {
  assert.deepEqual(await readJson(Readable.from(['{"a":', '1}'])), { a: 1 });
  assert.equal(await readJson(Readable.from([''])), null);
  assert.equal(await readJson(Readable.from(['nope'])), null);
});

test('decision constructors and hook JSON shapes', () => {
  assert.deepEqual(ask('r'), { kind: 'ask', reason: 'r' });
  assert.deepEqual(toHookJson('PreToolUse', ask('why')), {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'why' },
  });
  assert.deepEqual(toHookJson('PreToolUse', deny('no')).hookSpecificOutput.permissionDecision, 'deny');
  assert.deepEqual(toHookJson('PostToolUse', block('fix')), { decision: 'block', reason: 'fix' });
  assert.deepEqual(toHookJson('Stop', block('fix')), { decision: 'block', reason: 'fix' });
  assert.deepEqual(toHookJson('Stop', warn('released')), { systemMessage: 'released' });
  assert.equal(toHookJson('SessionStart', context('hello')), null); // context is printed as plain text, not JSON
  assert.equal(toHookJson('PreToolUse', null), null);
});

test('pickDecision: deny beats ask beats null', () => {
  assert.deepEqual(pickDecision([null, ask('a'), deny('d'), ask('b')]), deny('d'));
  assert.deepEqual(pickDecision([null, ask('a')]), ask('a'));
  assert.equal(pickDecision([null, null]), null);
});

test('meta reads plugin.json', () => {
  assert.match(pluginRoot(), /plugins\/cc-harness$/);
  assert.match(pluginVersion(), /^\d+\.\d+\.\d+$/);
});
