import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJson, toHookJson, pickDecision, ask } from './hook-io.mjs';
import { loadConfig, isGuardEnabled } from './config.mjs';
import { guardsFor } from './guards/index.mjs';
import { pluginRoot, pluginVersion } from './meta.mjs';
import { defaultExec } from './checks.mjs';
import { diagnose } from './doctor.mjs';
import { init, syncRules, parseInitArgs } from './init.mjs';

const USAGE = `usage: harness <command>

  hook <PreToolUse|PostToolUse|Stop|SessionStart>   run guards for a hook event (stdin: hook JSON)
  init [--preset ts|custom] [--types a,b] [--scopes a,b] [--marketplace owner/repo|path] [--force] [--dry-run] [--target dir] [--name <project>]
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

export function evaluateGuards(event, ctx, { onError } = {}) {
  const out = [];
  for (const g of guardsFor(event)) {
    if (!isGuardEnabled(ctx.config, g.name) && !g.alwaysRun) continue;
    try {
      out.push({ guard: g.name, decision: g.evaluate(ctx) });
    } catch (e) {
      if (onError) onError(g, e);
      out.push({
        guard: g.name,
        decision: event === 'PreToolUse' ? ask(`cc-harness: guard "${g.name}" crashed (${e.message}); confirm manually.`) : null,
      });
    }
  }
  return out;
}

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
  if (event !== 'SessionStart' && config.project.markerFile && !fs.existsSync(path.join(projectDir, config.project.markerFile))) return 0;

  const ctx = {
    event, input, config, projectDir,
    dataDir: overrides.dataDir || io.env.CLAUDE_PLUGIN_DATA || path.join(os.tmpdir(), 'cc-harness'),
    pluginRoot: pluginRoot(),
    exec: overrides.exec ?? defaultExec,
    fs,
    now: () => Date.now(),
  };
  const results = evaluateGuards(event, ctx, {
    onError: (g, e) => io.stderr.write(`cc-harness: guard "${g.name}" crashed: ${e.stack || e}\n`),
  });
  const d = pickDecision(results.map((r) => r.decision));
  if (!d) return 0;
  if (d.kind === 'context') { io.stdout.write(d.reason.endsWith('\n') ? d.reason : d.reason + '\n'); return 0; }
  emit(io, toHookJson(event, d));
  return 0;
}

function emit(io, obj) { if (obj) io.stdout.write(JSON.stringify(obj) + '\n'); }
async function runInit(args, io) { return init(parseInitArgs(args, io.env), io); }

async function runDoctor(args, io) {
  const target = path.resolve(argValue(args, '--target') ?? io.env.CLAUDE_PROJECT_DIR ?? process.cwd());
  const loaded = loadConfig(target);
  const report = diagnose({ projectDir: target, loaded, exec: defaultExec, fs, pluginVersion: pluginVersion() });
  for (const f of report.findings) io.stdout.write(`${{ ok: '✔', warn: '⚠', error: '✖' }[f.level]} ${f.text}\n`);
  io.stdout.write(`\n${report.summary}\n`);
  return report.findings.some((f) => f.level === 'error') ? 1 : 0;
}

export function argValue(args, flag) {
  const i = args.indexOf(flag);
  if (i !== -1) { const v = args[i + 1]; return v !== undefined && !v.startsWith('--') ? v : undefined; }
  const eq = args.find((a) => a.startsWith(flag + '='));
  return eq ? eq.slice(flag.length + 1) : undefined;
}

async function runSyncRules(args, io) { return syncRules({ targetDir: argValue(args, '--target') ?? io.env.CLAUDE_PROJECT_DIR ?? process.cwd() }, io); }
