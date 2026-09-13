import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJson, toHookJson, pickDecision, ask } from './hook-io.mjs';
import { loadConfig, isGuardEnabled } from './config.mjs';
import { guardsFor } from './guards/index.mjs';
import { pluginRoot, pluginVersion } from './meta.mjs';
import { defaultExec } from './checks.mjs';

const USAGE = `usage: harness <command>

  hook <PreToolUse|PostToolUse|Stop|SessionStart>   run guards for a hook event (stdin: hook JSON)
  init [--preset ts|custom] [--types a,b] [--scopes a,b] [--marketplace owner/repo|path] [--force] [--dry-run] [--target dir]
  doctor [--target dir]
  sync-rules [--target dir]
  version
`;

export async function run(argv, io) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'hook':
      return runHook(rest[0], io);
    case 'init':
      return runInit(rest, io);
    case 'doctor':
      return runDoctor(rest, io);
    case 'sync-rules':
      return runSyncRules(rest, io);
    case 'version':
      io.stdout.write(pluginVersion() + '\n');
      return 0;
    case undefined:
    case '--help':
    case '-h':
      io.stdout.write(USAGE);
      return 0;
    default:
      io.stderr.write(`harness: unknown command "${cmd}"\n${USAGE}`);
      return 1;
  }
}

const EVENTS = new Set(['PreToolUse', 'PostToolUse', 'Stop', 'SessionStart']);

export async function runHook(event, io, overrides = {}) {
  if (!EVENTS.has(event)) { io.stderr.write(`harness: unknown hook event "${event}"\n`); return 1; }
  const input = await readJson(io.stdin);
  if (!input) return 0;
  const projectDir = io.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  const loaded = loadConfig(projectDir, overrides.presetsDir ? { presetsDir: overrides.presetsDir } : {});
  if (loaded.status === 'absent') return 0;
  if (loaded.status === 'invalid') {
    const msg = `cc-harness: .claude/harness.json is invalid; guards are inactive until it is fixed.\n- ${loaded.errors.join('\n- ')}`;
    if (event === 'PreToolUse') emit(io, toHookJson(event, ask(msg)));
    else if (event === 'SessionStart') io.stdout.write(msg + '\n');
    else io.stderr.write(msg + '\n');
    return 0;
  }
  const config = loaded.config;
  if (config.project.markerFile && !fs.existsSync(path.join(projectDir, config.project.markerFile))) return 0;

  const ctx = {
    event, input, config, projectDir,
    dataDir: overrides.dataDir || io.env.CLAUDE_PLUGIN_DATA || path.join(os.tmpdir(), 'cc-harness'),
    pluginRoot: pluginRoot(),
    exec: overrides.exec ?? defaultExec,
    fs,
    now: () => Date.now(),
  };
  const decisions = [];
  for (const g of guardsFor(event)) {
    if (!isGuardEnabled(config, g.name) && !g.alwaysRun) continue;
    try {
      decisions.push(g.evaluate(ctx));
    } catch (e) {
      io.stderr.write(`cc-harness: guard "${g.name}" crashed: ${e.stack || e}\n`);
      if (event === 'PreToolUse') decisions.push(ask(`cc-harness: guard "${g.name}" crashed (${e.message}); confirm manually.`));
    }
  }
  const d = pickDecision(decisions);
  if (!d) return 0;
  if (d.kind === 'context') { io.stdout.write(d.reason.endsWith('\n') ? d.reason : d.reason + '\n'); return 0; }
  emit(io, toHookJson(event, d));
  return 0;
}

function emit(io, obj) { if (obj) io.stdout.write(JSON.stringify(obj) + '\n'); }
async function runInit(args, io) { return 0; }        // T6
async function runDoctor(args, io) { return 0; }      // T5
async function runSyncRules(args, io) { return 0; }   // T6
