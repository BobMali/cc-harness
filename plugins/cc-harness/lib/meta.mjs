import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function pluginRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

export function pluginVersion() {
  const manifest = path.join(pluginRoot(), '.claude-plugin', 'plugin.json');
  return JSON.parse(fs.readFileSync(manifest, 'utf8')).version ?? '0.0.0';
}
