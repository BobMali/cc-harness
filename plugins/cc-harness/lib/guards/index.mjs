import * as testGuard from './test.mjs';
import * as gitGuard from './git.mjs';
import * as commitGuard from './commit.mjs';
import * as qualityGuard from './quality.mjs';
import * as stopGuard from './stop.mjs';

// T5 adds preflightGuard.
export const GUARDS = [commitGuard, testGuard, gitGuard, qualityGuard, stopGuard];

export function guardsFor(event) {
  return GUARDS.filter((g) => g.event === event);
}
