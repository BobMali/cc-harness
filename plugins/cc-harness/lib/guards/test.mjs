import fs from 'node:fs';
import path from 'node:path';
import { matchesAny, mentionsAny } from '../glob.mjs';
import { splitSegments, tokenize, resolveTool, redirections, sedWriteTargets, isWrite, isSafe } from '../shell.mjs';
import { relTo, isOutside } from '../config.mjs';
import { ask } from '../hook-io.mjs';
import { isAppend, isBlockInsertion, addedText, affectsOtherTests } from '../test-edits.mjs';

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
    if (isOutside(rel) || matchesAny(rel, ignoreGlobs) || !matchesAny(rel, testGlobs)) return null;
    const abs = path.resolve(projectDir, ti.file_path);
    if (!fs.existsSync(abs)) return null;
    if (config.guards.test.allowAppend) {
      const current = fs.readFileSync(abs, 'utf8');
      const addition = isAppend(tool, ti, current) || (tool !== 'Write' && isBlockInsertion(ti.file_path, current, tool === 'Edit' ? [ti] : ti.edits));
      if (addition) {
        const marker = affectsOtherTests(addedText(tool, ti, current));
        if (!marker) return null;
        return ask(`${PREFIX}: the text added to ${rel} contains "${marker}", which changes how the existing tests run (focus, skip, or a shared hook). Explain why and ask before adding it.`);
      }
    }
    return ask(`${PREFIX}: ${rel} is an existing test file. Changing an existing test needs explicit permission; explain what the test gets wrong and ask before editing it. (Adding whole new tests, at the end or between existing ones, does not need permission.)`);
  }

  if (tool === 'Bash') {
    const command = typeof ti.command === 'string' ? ti.command : '';
    // A token counts as naming a test file when it mentions a test glob and does not point
    // outside the project or into an ignored path (node_modules and the like).
    const inScope = (t) => {
      if (!mentionsAny(t, testGlobs)) return false;
      const rel = relTo(projectDir, t);
      return !isOutside(rel) && !matchesAny(rel, ignoreGlobs);
    };
    for (const seg of splitSegments(command)) {
      const tokens = tokenize(seg);
      const tw = resolveTool(tokens, config.commands.runnerWrappers);
      const redirected = redirections(seg).filter((r) => !(r.append && config.guards.test.allowAppend)).map((r) => r.target).filter(inScope);
      if (redirected.length) return ask(`${PREFIX}: this command redirects output into the test file ${redirected[0]}.`);
      const appended = redirections(seg).filter((r) => r.append).map((r) => r.target).filter(inScope);
      const marker = appended.length ? affectsOtherTests(seg) : null;
      if (marker) return ask(`${PREFIX}: the text added to ${appended[0]} contains "${marker}", which changes how the existing tests run (focus, skip, or a shared hook). Explain why and ask before adding it.`);
      const sedTargets = tw.word === 'sed' ? sedWriteTargets(tw.args).filter(inScope) : [];
      if (sedTargets.length) return ask(`${PREFIX}: this sed script writes into the test file ${sedTargets[0]}.`);
      if (!tokens.some(inScope)) continue;
      if (isWrite(tokens, tw.word, config.commands.write)) {
        return ask(`${PREFIX}: "${tw.word}" rewrites files in place and the command names a test file. Confirm the test change first.`);
      }
      if (isSafe(tw, config)) continue;
      return ask(`${PREFIX}: "${tw.word || seg}" is not a known read-only or test-running command and the command names a test file. Confirm the test change first.`);
    }
  }
  return null;
}

