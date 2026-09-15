import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSuite } from '../evals/run.mjs';
import { loadCorpus, vectorId, validateVector } from '../evals/lib/corpus.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS = path.join(ROOT, 'evals', 'corpus');

test('adversarial vectors are well-formed with correct ids and unique', () => {
  const { vectors } = loadCorpus(CORPUS);
  const adv = vectors.filter((v) => v.source === 'adversarial');
  assert.ok(adv.length >= 60, `expected at least 60 adversarial vectors, got ${adv.length}`);
  const ids = new Set();
  for (const v of adv) {
    assert.deepEqual(validateVector(v), [], v.id);
    assert.equal(v.id, vectorId(v.lang, v.tool, v.input, Boolean(v.fixture)), `${v.id}: ${JSON.stringify(v.input)}`);
    assert.ok(v.expected, `${v.id} must be labelled`);
    assert.ok(!ids.has(v.id), `duplicate ${v.id}`); ids.add(v.id);
    assert.ok(v.note, `${v.id} needs a note naming its bypass class`);
  }
});

test('adversarial corpus runs clean: no mismatches, no closed gaps', () => {
  const r = runSuite({ corpusDir: CORPUS, configsDir: path.join(ROOT, 'evals', 'configs'), source: 'adversarial', quiet: true });
  const bad = r.results.filter((x) => x.status === 'mismatch' || x.status === 'gap-closed');
  assert.deepEqual(bad.map((x) => `${x.vector.id} ${x.status} expected ${JSON.stringify(x.vector.expected)} actual ${x.actual.kind}/${x.actual.guard}`), []);
  assert.equal(r.exitCode, 0);
});
