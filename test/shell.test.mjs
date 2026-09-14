import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitSegments, tokenize, resolveTool, redirectTargets, isWrite, isSafe, gitSubcommand } from '../plugins/cc-harness/lib/shell.mjs';
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

test('backslash-newline is a line continuation, not a separator', () => {
  assert.deepEqual(splitSegments('git commit -m "x" && \\\n  npx vitest run a.test.ts'), ['git commit -m "x"', 'npx vitest run a.test.ts']);
  assert.deepEqual(tokenize('npx prettier --write \\\n src/a.ts'), ['npx', 'prettier', '--write', 'src/a.ts']);
  assert.deepEqual(resolveTool(tokenize('npx vitest run \\\n a.test.ts'), W), { word: 'vitest', args: ['run', 'a.test.ts'] });
});

test('redirectTargets: unspaced, quoted target, and quoted > are handled', () => {
  assert.deepEqual(redirectTargets('echo x>a.test.ts'), ['a.test.ts']);
  assert.deepEqual(redirectTargets('echo x>>a.test.ts'), ['a.test.ts']);
  assert.deepEqual(redirectTargets('echo "a > b.test.ts"'), []);
  assert.deepEqual(redirectTargets('echo x > "my file.ts"'), ['my file.ts']);
  assert.deepEqual(redirectTargets('cmd 2>&1'), []);
  assert.deepEqual(redirectTargets('cmd >&2'), []);
});

test('heredoc bodies stay inside their segment', () => {
  const cmd = "cat > notes.md <<'EOF'\ngit reset --hard\nrm -rf build\nEOF\nls";
  assert.deepEqual(splitSegments(cmd), ["cat > notes.md <<'EOF'\ngit reset --hard\nrm -rf build\nEOF", 'ls']);
  assert.deepEqual(splitSegments('git commit -F - <<EOF\nfeat: z\nEOF'), ['git commit -F - <<EOF\nfeat: z\nEOF']);
});

test('a semicolon after a heredoc marker still splits', () => {
  assert.deepEqual(splitSegments('cat <<EOF; rm -rf build\nbody\nEOF'), ['cat <<EOF', 'rm -rf build\nbody\nEOF']);
  assert.deepEqual(splitSegments("cat <<'EOF' > f.test.ts; git add f.test.ts\nbody\nEOF"), ["cat <<'EOF' > f.test.ts", 'git add f.test.ts\nbody\nEOF']);
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

test('isWrite: both flag lists, multiple entries per cmd', () => {
  const wc = [{ cmd: 'x', whenFlags: ['--write'], unlessFlags: ['--dry-run'] }, { cmd: 'p', whenFlags: ['-w'] }, { cmd: 'p', whenFlags: ['--write'] }];
  assert.equal(isWrite(['x', '--write'], 'x', wc), true);
  assert.equal(isWrite(['x', '--write', '--dry-run'], 'x', wc), false);
  assert.equal(isWrite(['x'], 'x', wc), false);
  assert.equal(isWrite(['p', '--write'], 'p', wc), true);
  assert.equal(isWrite(['p', '-w'], 'p', wc), true);
});

test('isSafe: builtin list, config list, non-destructive git subcommands', () => {
  const cfg = mergeConfig(DEFAULTS, { commands: { safe: ['vitest'] } });
  assert.equal(isSafe({ word: 'cat', args: [] }, cfg), true);
  assert.equal(isSafe({ word: 'vitest', args: ['run'] }, cfg), true);
  assert.equal(isSafe({ word: 'sed', args: [] }, cfg), false);
  assert.equal(isSafe({ word: 'git', args: ['diff', 'x.test.ts'] }, cfg), true);
  assert.equal(isSafe({ word: 'git', args: ['checkout', 'x.test.ts'] }, cfg), false);
  assert.equal(isSafe({ word: 'test', args: [] }, cfg), true);
  assert.equal(isSafe({ word: 'find', args: ['.', '-delete'] }, cfg), false);
  assert.equal(isSafe({ word: 'git', args: ['stash', 'push', 'x.test.ts'] }, cfg), false);
  assert.equal(isSafe({ word: 'git', args: ['add', 'x.test.ts'] }, cfg), true);
  // F1: global opts like -C <dir> take a value and must not be mistaken for the subcommand
  assert.equal(isSafe({ word: 'git', args: ['-C', '/repo', 'diff', 'x.test.ts'] }, cfg), true);
  assert.equal(isSafe({ word: 'git', args: ['-C', '/repo', 'checkout', 'x.test.ts'] }, cfg), false);
});

test('gitSubcommand consumes a value for space-form globals, not just the = form', () => {
  assert.deepEqual(gitSubcommand(['--git-dir', '/x', 'commit', '-m', 'x']), { sub: 'commit', rest: ['-m', 'x'] });
  assert.deepEqual(gitSubcommand(['--work-tree=/x', 'reset', '--hard']), { sub: 'reset', rest: ['--hard'] });
  assert.deepEqual(gitSubcommand(['--namespace', 'ns', 'branch', '-D', 'x']), { sub: 'branch', rest: ['-D', 'x'] });
  assert.deepEqual(gitSubcommand(['--exec-path', '/bin', 'push', '--force']), { sub: 'push', rest: ['--force'] });
  assert.deepEqual(gitSubcommand(['--config-env', 'x=y', 'clean', '-f']), { sub: 'clean', rest: ['-f'] });
});
