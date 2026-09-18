import { matchesAny } from '../glob.mjs';
import { relTo, isOutside, isGuardEnabled } from '../config.mjs';
import { block } from '../hook-io.mjs';
import { selectChecks, runChecks, formatFailure } from '../checks.mjs';
import { markDirty } from '../session.mjs';

export const name = 'quality';
export const event = 'PostToolUse';
export const alwaysRun = true;   // must mark the session dirty even when disabled

export function evaluate({ input, config, projectDir, dataDir, exec, fs }) {
  const fp = input.tool_input?.file_path;
  if (typeof fp !== 'string' || !fp) return null;
  const rel = relTo(projectDir, fp);
  if (isOutside(rel)) return null;
  const { sourceGlobs, testGlobs, ignoreGlobs } = config.project;
  if (matchesAny(rel, ignoreGlobs)) return null;
  if (!matchesAny(rel, sourceGlobs) && !matchesAny(rel, testGlobs)) return null;
  if (input.session_id) markDirty(dataDir, input.session_id, rel);
  if (!isGuardEnabled(config, 'quality')) return null;
  const r = runChecks(selectChecks(config, { scope: config.guards.quality.scope }), { projectDir, exec, fs });
  return r.ok ? null : block(formatFailure(r.failed));
}
