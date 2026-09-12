import fs from 'node:fs';
import path from 'node:path';
import { matchesAny, mentionsAny } from '../glob.mjs';
import { splitSegments, tokenize, resolveTool, redirectTargets, isWrite, isSafe } from '../shell.mjs';
import { relTo } from '../config.mjs';
import { ask } from '../hook-io.mjs';

export const name = 'test';
export const event = 'PreToolUse';

const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);
const PREFIX = 'cc-harness test guard';

export function evaluate({ input, config, projectDir }) {
  const { testGlobs, ignoreGlobs } = config.project;
  if (!testGlobs.length) return null;
  const tool = input.tool_name;
  const ti = input.tool_input ?? {};

  if (EDIT_TOOLS.has(tool)) {
    if (typeof ti.file_path !== 'string' || !ti.file_path) return null;
    const rel = relTo(projectDir, ti.file_path);
    if (matchesAny(rel, ignoreGlobs) || !matchesAny(rel, testGlobs)) return null;
    if (!fs.existsSync(path.resolve(projectDir, ti.file_path))) return null;
    return ask(`${PREFIX}: ${rel} is an existing test file. Changing an existing test needs explicit permission; explain what the test gets wrong and ask before editing it.`);
  }

  if (tool === 'Bash') {
    const command = typeof ti.command === 'string' ? ti.command : '';
    for (const seg of splitSegments(command)) {
      const tokens = tokenize(seg);
      const tw = resolveTool(tokens, config.commands.runnerWrappers);
      const redirected = redirectTargets(seg).filter((t) => mentionsAny(t, testGlobs));
      if (redirected.length) return ask(`${PREFIX}: this command redirects output into the test file ${redirected[0]}.`);
      if (!mentionsAny(seg, testGlobs)) continue;
      if (isWrite(tokens, tw.word, config.commands.write)) {
        return ask(`${PREFIX}: "${tw.word}" rewrites files in place and the command names a test file. Confirm the test change first.`);
      }
      if (isSafe(tw, config)) continue;
      return ask(`${PREFIX}: "${tw.word || seg}" is not a known read-only or test-running command and the command names a test file. Confirm the test change first.`);
    }
  }
  return null;
}
