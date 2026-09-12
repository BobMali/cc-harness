import { test } from 'node:test';
import assert from 'node:assert/strict';
import { globToRegExp, matchesGlob, matchesAny, mentionsAny } from '../plugins/cc-harness/lib/glob.mjs';

test('* does not cross directory boundaries', () => {
  assert.equal(matchesGlob('a.test.ts', '*.test.ts'), true);
  assert.equal(matchesGlob('src/a.test.ts', '*.test.ts'), true); // basename fallback for slash-less globs
  assert.equal(matchesGlob('src/a.test.ts', 'src/*.ts'), true);
  assert.equal(matchesGlob('src/deep/a.test.ts', 'src/*.ts'), false);
});

test('** matches zero or more directories', () => {
  assert.equal(matchesGlob('a.test.ts', '**/*.test.*'), true);
  assert.equal(matchesGlob('src/deep/a.test.ts', '**/*.test.*'), true);
  assert.equal(matchesGlob('src/__tests__/a.ts', '**/__tests__/**'), true);
  assert.equal(matchesGlob('node_modules/x/index.js', '**/node_modules/**'), true);
  assert.equal(matchesGlob('src/a.ts', '**/__tests__/**'), false);
});

test('regex metacharacters in globs are literal', () => {
  assert.equal(matchesGlob('a.ts', '*.ts'), true);
  assert.equal(matchesGlob('ats', '*.ts'), false);
  assert.equal(globToRegExp('a+b').test('a+b'), true);
  assert.equal(globToRegExp('a+b').test('aab'), false);
});

test('matchesAny and mentionsAny', () => {
  assert.equal(matchesAny('x/y.spec.tsx', ['**/*.test.*', '**/*.spec.*']), true);
  assert.equal(matchesAny('x/y.tsx', ['**/*.test.*']), false);
  assert.equal(mentionsAny(`node -e "require('fs').writeFileSync('x.test.ts','')"`, ['**/*.test.*']), true);
  assert.equal(mentionsAny('vitest run', ['**/*.test.*']), false);
  assert.equal(mentionsAny('cat src/__tests__/a.ts', ['**/__tests__/**']), true);
});
