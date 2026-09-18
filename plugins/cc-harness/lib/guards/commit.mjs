import fs from 'node:fs';
import path from 'node:path';
import { flattenSegments, tokenize, resolveTool, gitSubcommand } from '../shell.mjs';
import { deny } from '../hook-io.mjs';
import { parseRegexFile, extractCommitMessage, checkMessage } from '../commit-rules.mjs';

export const name = 'commit';
export const event = 'PreToolUse';

export function evaluate({ input, config, projectDir }) {
  if (input.tool_name !== 'Bash') return null;
  const command = typeof input.tool_input?.command === 'string' ? input.tool_input.command : '';
  const { regexFile, rejectAttributionTrailers } = config.guards.commit;
  for (const seg of flattenSegments(command)) {
    const tokens = tokenize(seg);
    const tw = resolveTool(tokens, config.commands.runnerWrappers);
    if (tw.word !== 'git') continue;
    const { sub } = gitSubcommand(tw.args);
    if (sub !== 'commit') continue;
    const message = extractCommitMessage(command, seg, tokens, (f) => {
      // Missing file, directory (EISDIR), or unreadable: nothing to check; git will reject it.
      try { return fs.readFileSync(path.resolve(projectDir, f), 'utf8'); } catch { return null; }
    });
    if (message === null) continue;
    const regexPath = path.resolve(projectDir, regexFile);
    const rules = fs.existsSync(regexPath)
      ? parseRegexFile(fs.readFileSync(regexPath, 'utf8'))
      : { regex: null, types: [], scopes: [], error: `${regexFile} not found; run /cc-harness:init or create it` };
    const errors = checkMessage(message, rules, { rejectAttributionTrailers });
    if (errors.length) return deny(`cc-harness commit guard rejected the commit message:\n- ${errors.join('\n- ')}\nThe same rule is enforced by ${regexFile} in the git commit-msg hook and in CI.`);
  }
  return null;
}
