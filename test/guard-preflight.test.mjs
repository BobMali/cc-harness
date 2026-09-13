import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { evaluate } from '../plugins/cc-harness/lib/guards/preflight.mjs';
import { markDirty, markerPath, readMarker } from '../plugins/cc-harness/lib/session.mjs';
import { DEFAULTS, mergeConfig } from '../plugins/cc-harness/lib/config.mjs';
import { makeProject, makeDataDir } from './helpers/project.mjs';

const exec = (cmd) => ({ status: 0, output: cmd.includes('hooksPath') ? 'githooks\n' : 'git version 2\n' });

test('preflight returns a context block and prunes old markers on startup only', () => {
  const p = makeProject({ config: { version: 1 } }); const d = makeDataDir();
  try {
    markDirty(d.dir, 'old', 'x');
    const past = new Date(Date.now() - 10 * 86400e3); fs.utimesSync(markerPath(d.dir, 'old'), past, past);
    const config = mergeConfig(DEFAULTS, {});
    const resume = evaluate({ event: 'SessionStart', input: { source: 'resume', session_id: 's' }, config, projectDir: p.dir, dataDir: d.dir, exec, fs, pluginRoot: '' });
    assert.equal(resume.kind, 'context'); assert.match(resume.reason, /^cc-harness v/);
    assert.notEqual(readMarker(d.dir, 'old'), null);
    evaluate({ event: 'SessionStart', input: { source: 'startup', session_id: 's' }, config, projectDir: p.dir, dataDir: d.dir, exec, fs, pluginRoot: '' });
    assert.equal(readMarker(d.dir, 'old'), null);
  } finally { p.cleanup(); d.cleanup(); }
});
