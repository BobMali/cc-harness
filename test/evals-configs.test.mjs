import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../plugins/cc-harness/lib/config.mjs';
import { makeProject } from './helpers/project.mjs';

const CONFIGS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'evals', 'configs');

test('every eval config loads through loadConfig as a valid config', () => {
  const names = fs.readdirSync(CONFIGS).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
  assert.deepEqual(names.sort(), ['go', 'none', 'php', 'swift', 'ts']);
  for (const n of names) {
    const p = makeProject({ files: { '.claude/harness.json': fs.readFileSync(path.join(CONFIGS, `${n}.json`), 'utf8') } });
    try {
      const r = loadConfig(p.dir);
      assert.equal(r.status, 'ok', `${n}: ${JSON.stringify(r.errors)}`);
      if (n !== 'none') assert.ok(r.config.project.testGlobs.length > 0, `${n} has test globs`);
    } finally { p.cleanup(); }
  }
});
