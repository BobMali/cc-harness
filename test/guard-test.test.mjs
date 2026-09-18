import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { evaluate } from '../plugins/cc-harness/lib/guards/test.mjs';
import { DEFAULTS, mergeConfig } from '../plugins/cc-harness/lib/config.mjs';
import { makeProject } from './helpers/project.mjs';

const cfg = mergeConfig(DEFAULTS, {
  project: { testGlobs: ['**/*.test.*', '**/*.spec.*', '**/__tests__/**'], sourceGlobs: ['**/*.ts'] },
  commands: {
    safe: ['node', 'vitest', 'jest', 'eslint', 'prettier', 'tsc'],
    write: [
      { cmd: 'prettier', whenFlags: ['--write', '-w'] },
      { cmd: 'eslint', whenFlags: ['--fix'] },
      { cmd: 'node', whenFlags: ['-e', '--eval', '-p', '--print'] },
    ],
  },
});

function ctx(p, tool, tool_input) {
  return { event: 'PreToolUse', input: { tool_name: tool, tool_input }, config: cfg, projectDir: p.dir };
}

test('edit tools: existing test file asks, new test file and source file pass', () => {
  const p = makeProject({ files: { 'src/a.test.ts': 'x', 'src/a.ts': 'y' } });
  try {
    const existing = evaluate(ctx(p, 'Edit', { file_path: path.join(p.dir, 'src/a.test.ts'), old_string: 'x', new_string: 'z' }));
    assert.equal(existing?.kind, 'ask');
    assert.match(existing.reason, /src\/a\.test\.ts/);
    assert.equal(evaluate(ctx(p, 'Write', { file_path: path.join(p.dir, 'src/b.test.ts'), content: '' })), null);
    assert.equal(evaluate(ctx(p, 'Edit', { file_path: path.join(p.dir, 'src/a.ts') })), null);
    assert.equal(evaluate(ctx(p, 'MultiEdit', { file_path: path.join(p.dir, 'src/a.test.ts'), edits: [] }))?.kind, 'ask');
    assert.equal(evaluate(ctx(p, 'Edit', { file_path: path.join(p.dir, 'node_modules/x/a.test.ts') })), null); // ignored path
  } finally { p.cleanup(); }
});

test('bash: the ldsum vectors, translated', () => {
  const p = makeProject({ files: { 'x.test.ts': '' } });
  const bash = (command) => evaluate(ctx(p, 'Bash', { command }));
  try {
    assert.equal(bash('vitest run x.test.ts'), null);
    assert.equal(bash('npx vitest run x.test.ts'), null);
    assert.equal(bash('npm test -- x.test.ts'), null);
    assert.equal(bash('node_modules/.bin/vitest run src/x.test.ts'), null);
    assert.equal(bash('cat x.test.ts | head'), null);
    assert.equal(bash('git diff x.test.ts'), null);
    assert.equal(bash('prettier --check x.test.ts'), null);
    assert.equal(bash('vitest run'), null);
    assert.equal(bash(`sed -i '' 's/a/b/' x.test.ts`)?.kind, 'ask');
    assert.equal(bash('rm x.test.ts')?.kind, 'ask');
    assert.equal(bash('mv x.test.ts y.test.ts')?.kind, 'ask');
    assert.equal(bash('prettier --write x.test.ts')?.kind, 'ask');
    assert.equal(bash('eslint --fix src/x.test.ts')?.kind, 'ask');
    assert.equal(bash(`node -e "require('fs').writeFileSync('x.test.ts','')"`)?.kind, 'ask');
    assert.equal(bash('echo x > x.test.ts')?.kind, 'ask');
    assert.equal(bash('cat a.ts >> src/__tests__/b.ts')?.kind, 'ask');
    assert.equal(bash('npm run lint:fix x.test.ts')?.kind, 'ask'); // unknown script word, conservative
    assert.equal(bash('ls && rm x.test.ts')?.kind, 'ask');           // second segment
    assert.equal(bash('git checkout x.test.ts')?.kind, 'ask');
  } finally { p.cleanup(); }
});

test('no test globs configured → never asks', () => {
  const p = makeProject({ files: { 'x.test.ts': '' } });
  try {
    const c = { ...ctx(p, 'Bash', { command: 'rm x.test.ts' }), config: mergeConfig(DEFAULTS, {}) };
    assert.equal(evaluate(c), null);
  } finally { p.cleanup(); }
});

test('paths outside the project and ignored paths are out of scope in both arms', () => {
  const p = makeProject({ files: { 'x.test.ts': '', 'node_modules/pkg/a.test.js': '' } });
  const bash = (command) => evaluate(ctx(p, 'Bash', { command }));
  try {
    assert.equal(evaluate(ctx(p, 'Edit', { file_path: path.join(p.dir, '..', 'outside.test.ts') })), null);
    assert.equal(evaluate(ctx(p, 'Edit', { file_path: path.join(p.dir, 'node_modules/pkg/a.test.js') })), null);
    assert.equal(bash('rm ../outside.test.ts'), null);
    assert.equal(bash('echo x > ../outside.test.ts'), null);
    assert.equal(bash('rm node_modules/pkg/a.test.js'), null);
    assert.equal(bash('rm ../outside.test.ts && rm x.test.ts')?.kind, 'ask');
    assert.equal(bash('echo x > x.test.ts')?.kind, 'ask');
  } finally { p.cleanup(); }
});
