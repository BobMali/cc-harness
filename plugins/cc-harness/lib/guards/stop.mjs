import { checksByName } from '../config.mjs';
import { block, warn } from '../hook-io.mjs';
import { runChecks, formatFailure } from '../checks.mjs';
import { readMarker, writeMarker, clearMarker } from '../session.mjs';

export const name = 'stop';
export const event = 'Stop';

export function evaluate({ input, config, projectDir, dataDir, exec, fs }) {
  const sid = input.session_id;
  if (!sid) return null;
  const marker = readMarker(dataDir, sid);
  if (!marker || !marker.dirty) return null;
  const { checks: names, maxBlocks } = config.guards.stop;
  const r = runChecks(checksByName(config, names), { projectDir, exec, fs });
  if (r.ok) { clearMarker(dataDir, sid); return null; }
  const blocks = (marker.blocks ?? 0) + 1;
  if (blocks <= maxBlocks) {
    writeMarker(dataDir, sid, { ...marker, blocks });
    return block(`cc-harness stop gate (${blocks}/${maxBlocks}): the definition of done is not met.\n${formatFailure(r.failed)}`);
  }
  clearMarker(dataDir, sid);
  return warn(`cc-harness: stop gate released after ${maxBlocks} blocks; check "${r.failed.name}" is still failing.`);
}
