import { splitSegments, tokenize, resolveTool, gitSubcommand } from '../shell.mjs';
import { ask } from '../hook-io.mjs';

export const name = 'git';
export const event = 'PreToolUse';

const SHORT_F = /^-[a-zA-Z]*f[a-zA-Z]*$/;   // -f, -fd, -fdx, -uf ...
const SHORT_D = /^-[a-zA-Z]*D[a-zA-Z]*$/;   // -D, -Df, -fD ...
const RULES = [
  { when: (s, a) => s === 'reset' && a.includes('--hard'), what: 'discards every uncommitted change in the working tree' },
  { when: (s, a) => s === 'checkout' && (a.includes('.') || (a.includes('--') && a.length > a.indexOf('--') + 1)), what: 'overwrites working-tree files with the committed version' },
  { when: (s, a) => s === 'restore' && a.includes('.') && !a.includes('--staged'), what: 'overwrites working-tree files with the committed version' },
  { when: (s, a) => s === 'clean' && a.some((t) => t === '--force' || SHORT_F.test(t)), what: 'deletes untracked files' },
  { when: (s, a) => s === 'push' && a.some((t) => t === '--force' || SHORT_F.test(t) || /^\+/.test(t)), what: 'rewrites remote history (use --force-with-lease if a force push is intended)' },
  {
    when: (s, a) => s === 'branch' && (a.includes('-D') || a.some((t) => SHORT_D.test(t)) || (a.includes('--delete') && (a.includes('--force') || a.includes('-f')))),
    what: 'deletes a branch even if it is unmerged',
  },
  { when: (s, a) => s === 'stash' && (a[0] === 'drop' || a[0] === 'clear'), what: 'discards stashed changes' },
];

export function evaluate({ input, config }) {
  if (input.tool_name !== 'Bash') return null;
  const command = typeof input.tool_input?.command === 'string' ? input.tool_input.command : '';
  for (const seg of splitSegments(command)) {
    const tw = resolveTool(tokenize(seg), config.commands.runnerWrappers);
    if (tw.word !== 'git') continue;
    const { sub, rest } = gitSubcommand(tw.args);
    for (const r of RULES) {
      if (r.when(sub, rest)) return ask(`cc-harness git guard: "${seg}" ${r.what}. Confirm before running it.`);
    }
  }
  return null;
}
