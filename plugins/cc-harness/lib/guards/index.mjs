import * as testGuard from './test.mjs';
import * as gitGuard from './git.mjs';

// T3 adds commitGuard, T4 adds qualityGuard and stopGuard, T5 adds preflightGuard.
export const GUARDS = [testGuard, gitGuard];

export function guardsFor(event) {
  return GUARDS.filter((g) => g.event === event);
}
