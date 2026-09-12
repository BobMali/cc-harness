import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitSegments, tokenize, resolveTool, redirectTargets, isWrite, isSafe } from '../plugins/cc-harness/lib/shell.mjs';
import { DEFAULTS, mergeConfig } from '../plugins/cc-harness/lib/config.mjs';

const W = ['npx', 'pnpm', 'yarn', 'bunx', 'bun', 'npm'];

test('splitSegments splits on ; && || | and newline, not inside quotes or 2>&1', () => {
  assert.deepEqual(splitSegments('a; b && c || d | e\nf'), ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.deepEqual(splitSegments(`echo "a;b" && echo 'c|d'`), ['echo "a;b"', `echo 'c|d'`]);
  assert.deepEqual(splitSegments('cmd 2>&1 | tee out'), ['cmd 2>&1', 'tee out']);
  assert.deepEqual(splitSegments('  '), []);
});

test('tokenize is quote-aware', () => {
  assert.deepEqual(tokenize(`sed -i '' "s/a b/c/" x.test.ts`), ['sed', '-i', '', 's/a b/c/', 'x.test.ts']);
  assert.deepEqual(tokenize(`node -e "require('fs')"`), ['node', '-e', "require('fs')"]);
});

test('resolveTool strips env assignments, paths, and runner wrappers', () => {
  assert.deepEqual(resolveTool(tokenize('FOO=1 env vendor/bin/phpunit tests/A.php'), W), { word: 'phpunit', args: ['tests/A.php'] });
  assert.deepEqual(resolveTool(tokenize('npx vitest run x.test.ts'), W), { word: 'vitest', args: ['run', 'x.test.ts'] });
  assert.deepEqual(resolveTool(tokenize('npm run lint:fix src'), W), { word: 'lint:fix', args: ['src'] });
  assert.deepEqual(resolveTool(tokenize('npm test -- x.test.ts'), W), { word: 'test', args: ['--', 'x.test.ts'] });
  assert.deepEqual(resolveTool(tokenize('pnpm exec eslint --fix .'), W), { word: 'eslint', args: ['--fix', '.'] });
  assert.deepEqual(resolveTool(tokenize('node_modules/.bin/tsc --noEmit'), W), { word: 'tsc', args: ['--noEmit'] });
  assert.deepEqual(resolveTool([], W), { word: '', args: [] });
});

test('redirectTargets finds > and >> targets, ignores 2>&1', () => {
  assert.deepEqual(redirectTargets('echo x > a.test.ts'), ['a.test.ts']);
  assert.deepEqual(redirectTargets('echo x >>b.spec.js 2>&1'), ['b.spec.js']);
  assert.deepEqual(redirectTargets('cat a.test.ts'), []);
});

test('isWrite consults whenFlags / unlessFlags / bare entries', () => {
  const wc = [
    { cmd: 'prettier', whenFlags: ['--write', '-w'] },
    { cmd: 'php-cs-fixer', unlessFlags: ['--dry-run'] },
    { cmd: 'phpcbf' },
  ];
  assert.equal(isWrite(['prettier', '--check', '.'], 'prettier', wc), false);
  assert.equal(isWrite(['prettier', '-w', '.'], 'prettier', wc), true);
  assert.equal(isWrite(['php-cs-fixer', 'fix', '--dry-run'], 'php-cs-fixer', wc), false);
  assert.equal(isWrite(['php-cs-fixer', 'fix'], 'php-cs-fixer', wc), true);
  assert.equal(isWrite(['phpcbf', 'x'], 'phpcbf', wc), true);
  assert.equal(isWrite(['cat', 'x'], 'cat', wc), false);
});

test('isSafe: builtin list, config list, git read-only subcommands', () => {
  const cfg = mergeConfig(DEFAULTS, { commands: { safe: ['vitest'] } });
  assert.equal(isSafe({ word: 'cat', args: [] }, cfg), true);
  assert.equal(isSafe({ word: 'vitest', args: ['run'] }, cfg), true);
  assert.equal(isSafe({ word: 'sed', args: [] }, cfg), false);
  assert.equal(isSafe({ word: 'git', args: ['diff', 'x.test.ts'] }, cfg), true);
  assert.equal(isSafe({ word: 'git', args: ['checkout', 'x.test.ts'] }, cfg), false);
  assert.equal(isSafe({ word: 'test', args: [] }, cfg), true);
});
