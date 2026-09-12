import { splitSegments, tokenize, resolveTool } from '../shell.mjs';
import { ask } from '../hook-io.mjs';

export const name = 'git';
export const event = 'PreToolUse';

const SHORT_F = /^-[a-zA-Z]*f[a-zA-Z]*$/;   // -f, -fd, -fdx, -uf ...
const RULES = [
  { when: (s, a) => s === 'reset' && a.includes('--hard'), what: 'discards every uncommitted change in the working tree' },
  { when: (s, a) => s === 'checkout' && (a.includes('.') || (a.includes('--') && a.length > a.indexOf('--') + 1)), what: 'overwrites working-tree files with the committed version' },
  { when: (s, a) => s === 'restore' && a.includes('.') && !a.includes('--staged'), what: 'overwrites working-tree files with the committed version' },
  { when: (s, a) => s === 'clean' && a.some((t) => t === '--force' || SHORT_F.test(t)), what: 'deletes untracked files' },
  { when: (s, a) => s === 'push' && a.some((t) => t === '--force' || SHORT_F.test(t)), what: 'rewrites remote history (use --force-with-lease if a force push is intended)' },
  { when: (s, a) => s === 'branch' && a.includes('-D'), what: 'deletes a branch even if it is unmerged' },
  { when: (s, a) => s === 'stash' && (a[0] === 'drop' || a[0] === 'clear'), what: 'discards stashed changes' },
];

// git [global opts] <subcommand> [args]; global opts like -C <dir> and -c k=v take a value
function splitGit(args) {
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) {
    if (args[i] === '-C' || args[i] === '-c') i += 2; else i += 1;
  }
  return { sub: args[i] ?? '', rest: args.slice(i + 1) };
}

export function evaluate({ input, config }) {
  if (input.tool_name !== 'Bash') return null;
  const command = typeof input.tool_input?.command === 'string' ? input.tool_input.command : '';
  for (const seg of splitSegments(command)) {
    const tw = resolveTool(tokenize(seg), config.commands.runnerWrappers);
    if (tw.word !== 'git') continue;
    const { sub, rest } = splitGit(tw.args);
    for (const r of RULES) {
      if (r.when(sub, rest)) return ask(`cc-harness git guard: "${seg}" ${r.what}. Confirm before running it.`);
    }
  }
  return null;
}
