import { context } from '../hook-io.mjs';
import { diagnose, formatStatus } from '../doctor.mjs';
import { pruneMarkers } from '../session.mjs';
import { pluginVersion } from '../meta.mjs';

export const name = 'preflight';
export const event = 'SessionStart';
const SEVEN_DAYS = 7 * 86400e3;

export function evaluate({ input, config, projectDir, dataDir, exec, fs }) {
  if (input.source === 'startup') { try { pruneMarkers(dataDir, SEVEN_DAYS); } catch { /* best effort */ } }
  const v = pluginVersion();
  const report = diagnose({ projectDir, loaded: { status: 'ok', config }, exec, fs, pluginVersion: v });
  return context(formatStatus(report, { pluginVersion: v, config }));
}
