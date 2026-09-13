import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { markerPath, readMarker, writeMarker, markDirty, clearMarker, pruneMarkers } from '../plugins/cc-harness/lib/session.mjs';
import { makeDataDir } from './helpers/project.mjs';

test('marker lifecycle', () => {
  const d = makeDataDir();
  try {
    assert.equal(readMarker(d.dir, 's1'), null);
    markDirty(d.dir, 's1', 'src/a.ts');
    markDirty(d.dir, 's1', 'src/a.ts');
    markDirty(d.dir, 's1', 'src/b.ts');
    const m = readMarker(d.dir, 's1');
    assert.equal(m.dirty, true); assert.equal(m.blocks, 0); assert.deepEqual(m.files, ['src/a.ts', 'src/b.ts']);
    writeMarker(d.dir, 's1', { ...m, blocks: 2 });
    assert.equal(readMarker(d.dir, 's1').blocks, 2);
    assert.equal(readMarker(d.dir, 's2'), null);           // sessions are isolated
    clearMarker(d.dir, 's1'); clearMarker(d.dir, 's1');    // idempotent
    assert.equal(readMarker(d.dir, 's1'), null);
    assert.match(markerPath(d.dir, '../../evil'), /sessions\/[A-Za-z0-9_.-]+\.json$/);
    assert.ok(!markerPath(d.dir, '../../evil').includes('..'));
  } finally { d.cleanup(); }
});

test('pruneMarkers removes old files only', () => {
  const d = makeDataDir();
  try {
    markDirty(d.dir, 'old', 'x'); markDirty(d.dir, 'new', 'y');
    const oldPath = markerPath(d.dir, 'old');
    const past = new Date(Date.now() - 10 * 86400e3);
    fs.utimesSync(oldPath, past, past);
    assert.equal(pruneMarkers(d.dir, 7 * 86400e3), 1);
    assert.equal(readMarker(d.dir, 'old'), null); assert.notEqual(readMarker(d.dir, 'new'), null);
    assert.equal(pruneMarkers('/nonexistent/dir', 1), 0);
  } finally { d.cleanup(); }
});

test('corrupt or empty marker fails closed', () => {
  const d = makeDataDir();
  try {
    markDirty(d.dir, 's1', 'a.ts');
    const p = markerPath(d.dir, 's1');

    fs.writeFileSync(p, '{not json');
    const m1 = readMarker(d.dir, 's1');
    assert.equal(m1.dirty, true); assert.equal(m1.blocks, 0); assert.deepEqual(m1.files, []); assert.equal(m1.corrupt, true);

    fs.writeFileSync(p, '');
    const m2 = readMarker(d.dir, 's1');
    assert.equal(m2.dirty, true); assert.equal(m2.corrupt, true);
  } finally { d.cleanup(); }
});

test('writeMarker uses a tmp file and renames; no .tmp file remains', () => {
  const d = makeDataDir();
  try {
    writeMarker(d.dir, 's1', { dirty: true, blocks: 0, files: [] });
    const files = fs.readdirSync(path.join(d.dir, 'sessions'));
    assert.ok(!files.some((f) => f.endsWith('.tmp')));
    assert.equal(readMarker(d.dir, 's1').dirty, true);
  } finally { d.cleanup(); }
});
