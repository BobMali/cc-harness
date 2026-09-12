export async function readJson(stream) {
  let s = '';
  for await (const chunk of stream) s += chunk;
  s = s.trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

export const ask = (reason) => ({ kind: 'ask', reason });
export const deny = (reason) => ({ kind: 'deny', reason });
export const block = (reason) => ({ kind: 'block', reason });
export const context = (text) => ({ kind: 'context', reason: text });
export const warn = (reason) => ({ kind: 'warn', reason });

const RANK = { deny: 3, ask: 2, block: 2, warn: 1, context: 1 };

export function pickDecision(decisions) {
  let best = null;
  for (const d of decisions) {
    if (!d) continue;
    if (!best || RANK[d.kind] > RANK[best.kind]) best = d;
  }
  return best;
}

export function toHookJson(event, decision) {
  if (!decision) return null;
  switch (decision.kind) {
    case 'ask':
    case 'deny':
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision.kind, permissionDecisionReason: decision.reason } };
    case 'block':
      return { decision: 'block', reason: decision.reason };
    case 'warn':
      return { systemMessage: decision.reason };
    default:
      return null;
  }
}
