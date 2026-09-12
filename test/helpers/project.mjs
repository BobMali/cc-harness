import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// makeProject({ config, files, marker }) → { dir, cleanup, write, read, exists }
// config: object written to .claude/harness.json (omit to create no config)
// files:  { 'relative/path': 'content' }
export function makeProject({ config, files = {}, marker } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-harness-'));
  const write = (rel, content, mode) => {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    if (mode) fs.chmodSync(abs, mode);
    return abs;
  };
  if (config !== undefined) write('.claude/harness.json', JSON.stringify(config, null, 2));
  if (marker) write(marker, '{}');
  for (const [rel, content] of Object.entries(files)) write(rel, content);
  return {
    dir,
    write,
    read: (rel) => fs.readFileSync(path.join(dir, rel), 'utf8'),
    exists: (rel) => fs.existsSync(path.join(dir, rel)),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

export function makeDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-harness-data-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
