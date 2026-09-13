import fs from 'node:fs';
import path from 'node:path';

const safeId = (id) => String(id).replace(/[^A-Za-z0-9_.-]/g, '_').replace(/\.\.+/g, '_') || 'unknown';

export function markerPath(dataDir, sessionId) {
  return path.join(dataDir, 'sessions', `${safeId(sessionId)}.json`);
}

export function readMarker(dataDir, sessionId) {
  const f = markerPath(dataDir, sessionId);
  if (!fs.existsSync(f)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { dirty: true, blocks: 0, files: [], corrupt: true };
    }
    return parsed;
  } catch {
    return { dirty: true, blocks: 0, files: [], corrupt: true };
  }
}

export function writeMarker(dataDir, sessionId, marker) {
  const f = markerPath(dataDir, sessionId);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...marker, updatedAt: Date.now() }));
  fs.renameSync(tmp, f);
}

export function markDirty(dataDir, sessionId, relFile) {
  const m = readMarker(dataDir, sessionId) ?? { dirty: false, blocks: 0, files: [] };
  m.dirty = true;
  if (relFile && !m.files.includes(relFile)) m.files.push(relFile);
  writeMarker(dataDir, sessionId, m);
}

export function clearMarker(dataDir, sessionId) {
  fs.rmSync(markerPath(dataDir, sessionId), { force: true });
}

export function pruneMarkers(dataDir, maxAgeMs, now = Date.now()) {
  const dir = path.join(dataDir, 'sessions');
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    try { if (now - fs.statSync(p).mtimeMs > maxAgeMs) { fs.rmSync(p, { force: true }); n++; } } catch { /* ignore */ }
  }
  return n;
}
