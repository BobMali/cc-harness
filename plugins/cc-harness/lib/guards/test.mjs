import fs from 'node:fs';
import path from 'node:path';
import { matchesAny, mentionsAny } from '../glob.mjs';
import { splitSegments, tokenize, resolveTool, redirections, sedWriteTargets, isWrite, isSafe } from '../shell.mjs';
import { relTo, isOutside } from '../config.mjs';
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
    if (isOutside(rel) || matchesAny(rel, ignoreGlobs) || !matchesAny(rel, testGlobs)) return null;
    const abs = path.resolve(projectDir, ti.file_path);
    if (!fs.existsSync(abs)) return null;
    if (config.guards.test.allowAppend && isAppend(tool, ti, fs.readFileSync(abs, 'utf8'))) return null;
    return ask(`${PREFIX}: ${rel} is an existing test file. Changing an existing test needs explicit permission; explain what the test gets wrong and ask before editing it. (Appending new tests at the end of the file does not need permission.)`);
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

// True when the edit only adds text after the current end of the file: a Write whose content
// starts with the current content, or Edit/MultiEdit steps whose old_string is the file's tail
// (trailing whitespace ignored) and whose new_string starts with that old_string. Anything that
// removes, replaces, or inserts before the tail is a change.
function isAppend(tool, ti, current) {
  if (tool === 'Write') return typeof ti.content === 'string' && ti.content.startsWith(current);
  const edits = tool === 'Edit' ? [ti] : Array.isArray(ti.edits) ? ti.edits : null;
  if (!edits || !edits.length) return false;
  let text = current;
  for (const e of edits) {
    if (typeof e.old_string !== 'string' || typeof e.new_string !== 'string' || e.replace_all) return false;
    const anchor = e.old_string.trimEnd();
    if (!anchor || !e.new_string.startsWith(e.old_string) || !text.trimEnd().endsWith(anchor)) return false;
    const idx = text.lastIndexOf(e.old_string);
    if (idx === -1) return false;
    text = text.slice(0, idx) + e.new_string + text.slice(idx + e.old_string.length);
  }
  return true;
}
