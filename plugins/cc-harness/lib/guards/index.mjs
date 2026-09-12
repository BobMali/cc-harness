import * as testGuard from './test.mjs';
import * as gitGuard from './git.mjs';
import * as commitGuard from './commit.mjs';

// T4 adds qualityGuard and stopGuard, T5 adds preflightGuard.
export const GUARDS = [commitGuard, testGuard, gitGuard];

export function guardsFor(event) {
  return GUARDS.filter((g) => g.event === event);
}
