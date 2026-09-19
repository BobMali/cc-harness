import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULTS, mergeConfig, loadPreset, loadConfig, defaultPresetsDir } from './config.mjs';
import { render, deepMergeSettings, pruneSettings, buildRegex, templateVars, templatesDir, DEFAULT_TYPES } from './render.mjs';
import { parseRegexFile } from './commit-rules.mjs';
import { RULE_NAMES } from './doctor.mjs';
import { pluginRoot, pluginVersion } from './meta.mjs';

const PLUGIN_KEY = 'cc-harness@cc-harness';
const MARKET = 'cc-harness';
const LOCAL_SETTINGS = '.claude/settings.local.json';
// Generated record of the permission entries init last wrote into settings.json, so the next
// init can retire the ones the current config no longer produces. Committed beside harness.json.
const OWNED = '.claude/harness.owned.json';

// candidateDir is an override seam for tests: it defaults to the real "am I checked
// out inside a marketplace" resolution, but this repo dogfoods cc-harness on itself
// (it has its own .claude-plugin/marketplace.json), so a test that wants to exercise
// the known_marketplaces.json fallback below must point candidateDir somewhere else.
export function defaultMarketplace({ knownMarketplacesFile, candidateDir } = {}) {
  const candidate = candidateDir ?? path.resolve(pluginRoot(), '..', '..');
  if (fs.existsSync(path.join(candidate, '.claude-plugin', 'marketplace.json'))) return candidate;
  const file = knownMarketplacesFile ?? path.join(os.homedir(), '.claude', 'plugins', 'known_marketplaces.json');
  try {
    const known = JSON.parse(fs.readFileSync(file, 'utf8'));
    const source = known?.['cc-harness']?.source;
    if (source?.source === 'github' && source.repo) return source.repo;
    if (source?.source === 'directory' && source.path) return source.path;
  } catch { /* no known_marketplaces.json, unreadable, or invalid JSON: fall through */ }
  return 'BobMali/cc-harness';
}

export function parseInitArgs(args, env) {
  const val = (flag) => { const i = args.indexOf(flag); if (i !== -1) { const v = args[i + 1]; return v !== undefined && !v.startsWith('--') ? v : undefined; } const eq = args.find((a) => a.startsWith(flag + '=')); return eq ? eq.slice(flag.length + 1) : undefined; };
  const list = (s, dflt) => (s === undefined ? dflt : s.split(',').map((x) => x.trim()).filter(Boolean));
  const targetDir = path.resolve(val('--target') ?? env.CLAUDE_PROJECT_DIR ?? process.cwd());
  const types = list(val('--types'), DEFAULT_TYPES);
  return {
    targetDir,
    preset: val('--preset') ?? 'ts',
    types: types.length ? types : DEFAULT_TYPES,
    scopes: list(val('--scopes'), []),
    marketplace: val('--marketplace') ?? defaultMarketplace(),
    force: args.includes('--force'),
    dryRun: args.includes('--dry-run'),
    projectName: val('--name') ?? path.basename(targetDir),
  };
}

const isRepo = (m) => /^[\w-]+\/[\w.-]+$/.test(m);

// Generic runners and shell keywords: allowing "Bash(<word>:*)" for one of these
// would allow far more than the specific check that happened to start with it.
const GENERIC_FIRST_WORDS = new Set(['sh', 'bash', 'zsh', 'node', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'bunx', 'for', 'if', 'while', 'test', '[', 'env']);
const SHELL_SPECIAL_CHARS = /[;|&$(){}]/;
const firstWord = (cmd) => String(cmd).trim().split(/\s+/)[0] ?? '';
const cmdBasename = (w) => w.slice(w.lastIndexOf('/') + 1);

function permissionFragment(config) {
  const allow = new Set(['Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git branch:*)']);
  const writeCmds = new Set(config.commands.write.map((w) => w.cmd));
  for (const c of config.checks) {
    const fw = firstWord(c.cmd);
    if (!fw || GENERIC_FIRST_WORDS.has(fw) || SHELL_SPECIAL_CHARS.test(fw)) continue;
    if (writeCmds.has(cmdBasename(fw))) continue;
    allow.add(`Bash(${fw}:*)`);
  }
  const ask = new Set(['Bash(git push:*)', 'Bash(rm:*)']);
  for (const w of config.commands.write) {
    if (w.whenFlags) {
      for (const f of w.whenFlags) {
        ask.add(`Bash(${w.cmd} ${f}:*)`);
        for (const c of config.checks) {
          const fw = firstWord(c.cmd);
          if (cmdBasename(fw) === w.cmd) ask.add(`Bash(${fw} ${f}:*)`);
        }
      }
    } else ask.add(`Bash(${w.cmd}:*)`);
  }
  const deny = [
    'Read(**/.env)', 'Read(**/.env.*)', 'Edit(**/.env)', 'Edit(**/.env.*)',
    'Read(**/*.pem)', 'Edit(**/*.pem)', 'Read(**/credentials.*)', 'Edit(**/credentials.*)',
    'Read(~/.ssh/**)', 'Edit(~/.ssh/**)', 'Read(~/.gnupg/**)', 'Edit(~/.gnupg/**)',
  ];
  return { allow: [...allow], ask: [...ask], deny };
}

export function planInit(opts) {
  const presetsDir = opts.presetsDir ?? defaultPresetsDir();
  const tdir = opts.templatesDir ?? templatesDir();
  const version = opts.pluginVersion ?? pluginVersion();
  const preset = opts.preset === 'custom' ? {} : loadPreset(opts.preset, presetsDir);
  if (preset === null) throw new Error(`unknown preset "${opts.preset}"`);
  const presetConfig = mergeConfig(mergeConfig(DEFAULTS, preset), { preset: opts.preset });
  // Reflect the consumer's existing .claude/harness.json (e.g. a hand-edited
  // rejectAttributionTrailers or regexFile) so a second `init --force` and
  // every `sync-rules` keep honouring it instead of silently resetting it.
  const loaded = loadConfig(opts.targetDir, { presetsDir });
  // Only reuse the existing file when it was written for the same preset the caller
  // is (re-)initing with; a `--preset` switch should not inherit the old preset's
  // checks/commands/permissions just because a valid harness.json already exists.
  const reuseExisting = loaded.status === 'ok' && loaded.config.preset === opts.preset;
  const config = reuseExisting ? loaded.config : presetConfig;
  const vars = templateVars({ config, types: opts.types, scopes: opts.scopes, pluginVersion: version, projectName: opts.projectName });
  const tpl = (rel) => fs.readFileSync(path.join(tdir, rel), 'utf8');
  const exists = (rel) => fs.existsSync(path.join(opts.targetDir, rel));
  const writes = [];
  const refusals = [];

  const harnessJson = opts.preset === 'custom'
    ? { version: 1, preset: 'custom', project: { markerFile: '', sourceGlobs: [], testGlobs: [] }, commands: { safe: [], write: [] }, checks: [], guards: { stop: { checks: [] } } }
    : { version: 1, preset: opts.preset };
  if (exists('.claude/harness.json') && !opts.force) refusals.push('.claude/harness.json exists; pass --force to overwrite it');
  // When reusing the caller's existing harness.json (same preset), write back the
  // user's own file unchanged rather than the stub: the rendered hook/rules/CI
  // above were built from `config` (the loaded file), so the stub would otherwise
  // disagree with them (e.g. a custom regexFile the stub doesn't mention).
  const harnessJsonContent = reuseExisting
    ? JSON.stringify(JSON.parse(fs.readFileSync(path.join(opts.targetDir, '.claude/harness.json'), 'utf8')), null, 2) + '\n'
    : JSON.stringify(harnessJson, null, 2) + '\n';
  writes.push({ rel: '.claude/harness.json', content: harnessJsonContent, action: exists('.claude/harness.json') ? 'overwrite' : 'create' });

  const permissions = permissionFragment(config);
  const settingsFragment = { enabledPlugins: { [PLUGIN_KEY]: true }, permissions };
  // Harness-owned entries are the ones the previous init wrote (recorded in OWNED); any of
  // those the new config no longer produces are retired before merging, so a renamed check
  // or a dropped write command does not leave its permission behind. Entries the user added
  // by hand are untouched unless they coincide with a retired harness entry. Without the
  // record (a project set up before it existed) the previous fragment is derived from the
  // loaded config, which only helps on a preset switch.
  let prior = null;
  try { prior = JSON.parse(fs.readFileSync(path.join(opts.targetDir, OWNED), 'utf8')).permissions ?? null; } catch { prior = null; }
  if (!prior && loaded.status === 'ok') prior = permissionFragment(loaded.config);
  const stale = prior ? subtractFragment(prior, permissions) : null;
  // Own only what init adds: an entry the user already had before this init stays theirs
  // (and survives a later retirement) unless a previous init already owned it.
  const existingSettings = readJsonIfPresent(opts.targetDir, '.claude/settings.json');
  const owned = {};
  for (const k of ['allow', 'ask', 'deny']) {
    owned[k] = permissions[k].filter((e) => (prior?.[k] ?? []).includes(e) || !(existingSettings.permissions?.[k] ?? []).includes(e));
  }
  writes.push({ rel: OWNED, content: JSON.stringify({ generatedBy: 'cc-harness init; do not edit', version: 1, permissions: owned }, null, 2) + '\n', action: exists(OWNED) ? 'overwrite' : 'create' });
  const marketIsRepo = isRepo(opts.marketplace);
  const marketPath = marketIsRepo ? null : path.resolve(process.cwd(), opts.marketplace);
  const marketEntry = { [MARKET]: { source: marketIsRepo ? { source: 'github', repo: opts.marketplace } : { source: 'directory', path: marketPath } } };
  // The marketplace entry is harness-owned too: the requested source replaces an old one.
  const own = (settings) => (marketIsRepo ? { ...settings, extraKnownMarketplaces: { ...(settings.extraKnownMarketplaces ?? {}), ...marketEntry } } : settings);
  writes.push(mergeJsonWrite(opts.targetDir, '.claude/settings.json', settingsFragment, { stale: stale ? { permissions: stale } : null, finalize: own, existing: existingSettings }));
  if (!marketIsRepo) {
    writes.push(mergeJsonWrite(opts.targetDir, LOCAL_SETTINGS, {}, { finalize: (settings) => ({ ...settings, extraKnownMarketplaces: { ...(settings.extraKnownMarketplaces ?? {}), ...marketEntry } }) }));
    const gi = exists('.gitignore') ? fs.readFileSync(path.join(opts.targetDir, '.gitignore'), 'utf8') : '';
    if (!gi.split(/\r?\n/).includes(LOCAL_SETTINGS)) writes.push({ rel: '.gitignore', content: (gi && !gi.endsWith('\n') ? gi + '\n' : gi) + LOCAL_SETTINGS + '\n', action: gi ? 'append' : 'create' });
  }

  const claude = render(tpl('CLAUDE.md.tmpl'), vars);
  if (exists('CLAUDE.md')) writes.push({ rel: 'CLAUDE.harness.md', content: claude, action: 'beside' });
  else writes.push({ rel: 'CLAUDE.md', content: claude, action: 'create' });

  for (const n of RULE_NAMES) {
    const rel = `.claude/rules/harness-${n}.md`;
    writes.push({ rel, content: render(tpl(`rules/harness-${n}.md.tmpl`), vars), action: exists(rel) ? 'overwrite' : 'create' });
  }

  writes.push({ rel: 'githooks/commit-msg', content: render(tpl('githooks/commit-msg.tmpl'), vars), action: exists('githooks/commit-msg') ? 'overwrite' : 'create', mode: 0o755 });
  const regexRel = config.guards.commit.regexFile;
  if (exists(regexRel) && !opts.force) refusals.push(`${regexRel} exists (you may have edited it); pass --force to overwrite it`);
  writes.push({ rel: regexRel, content: render(tpl('githooks/conventional-regex.txt.tmpl'), vars), action: exists(regexRel) ? 'overwrite' : 'create' });

  writes.push({ rel: '.github/workflows/harness.yml', content: render(tpl('ci.yml.tmpl'), vars), action: exists('.github/workflows/harness.yml') ? 'overwrite' : 'create' });

  const checklist = [
    'git config core.hooksPath githooks',
    `claude plugin marketplace add ${marketIsRepo ? opts.marketplace : marketPath}`,
    `claude plugin install ${PLUGIN_KEY}`,
    exists('CLAUDE.md') ? 'merge CLAUDE.harness.md into your CLAUDE.md, then delete it' : 'fill in the placeholders in CLAUDE.md',
    'restart Claude Code (or /reload) so the plugin hooks load; the session preflight will confirm',
  ];
  return { writes, refusals, checklist };
}

// Entries of `prior` (per allow/ask/deny) that `next` no longer contains.
function subtractFragment(prior, next) {
  const out = {};
  for (const k of ['allow', 'ask', 'deny']) out[k] = (prior[k] ?? []).filter((x) => !(next[k] ?? []).includes(x));
  return out;
}

function readJsonIfPresent(targetDir, rel) {
  const abs = path.join(targetDir, rel);
  if (!fs.existsSync(abs)) return {};
  try { return JSON.parse(fs.readFileSync(abs, 'utf8')); } catch (e) { throw new Error(`${rel} is not valid JSON: ${e.message}`); }
}

function mergeJsonWrite(targetDir, rel, fragment, { stale = null, finalize = (s) => s, existing = null } = {}) {
  const abs = path.join(targetDir, rel);
  if (existing === null) existing = readJsonIfPresent(targetDir, rel);
  const pruned = stale ? pruneSettings(existing, stale) : existing;
  return { rel, content: JSON.stringify(finalize(deepMergeSettings(pruned, fragment)), null, 2) + '\n', action: fs.existsSync(abs) ? 'merge' : 'create' };
}

export function applyWrites(targetDir, writes, fsm = fs) {
  for (const w of writes) {
    const abs = path.join(targetDir, w.rel);
    fsm.mkdirSync(path.dirname(abs), { recursive: true });
    fsm.writeFileSync(abs, w.content);
    if (w.mode) fsm.chmodSync(abs, w.mode);
  }
}

export function init(opts, io) {
  let plan;
  try { plan = planInit(opts); } catch (e) { io.stderr.write(`cc-harness init: ${e.message}\n`); return 1; }
  if (plan.refusals.length) {
    io.stderr.write(`cc-harness init: refusing to continue; nothing was written.\n- ${plan.refusals.join('\n- ')}\n`);
    return 1;
  }
  const width = Math.max(...plan.writes.map((w) => w.rel.length));
  for (const w of plan.writes) io.stdout.write(`${opts.dryRun ? '[dry-run] ' : ''}${w.action.padEnd(9)} ${w.rel.padEnd(width)}\n`);
  if (opts.dryRun) return 0;
  applyWrites(opts.targetDir, plan.writes);
  io.stdout.write(`\ncc-harness ${opts.pluginVersion ?? pluginVersion()} installed into ${opts.targetDir} (preset ${opts.preset}).\nNext steps:\n${plan.checklist.map((c, i) => `  ${i + 1}. ${c}`).join('\n')}\n`);
  return 0;
}

// Shared by sync-rules and sync-ci: load harness.json and the commit regex file, and build
// the template variables from them. Returns null (after reporting) when the config is unusable.
function loadSyncVars(name, opts, io) {
  const targetDir = path.resolve(opts.targetDir);
  const version = opts.pluginVersion ?? pluginVersion();
  const loaded = loadConfig(targetDir, opts.presetsDir ? { presetsDir: opts.presetsDir } : {});
  if (loaded.status !== 'ok') { io.stderr.write(`cc-harness ${name}: ${loaded.status === 'absent' ? '.claude/harness.json not found; run init first' : loaded.errors.join('; ')}\n`); return null; }
  const config = loaded.config;
  const regexRel = config.guards.commit.regexFile;
  const regexAbs = path.join(targetDir, regexRel);
  const regexExists = fs.existsSync(regexAbs);
  let rules = { types: [], scopes: [] };
  if (regexExists) {
    rules = parseRegexFile(fs.readFileSync(regexAbs, 'utf8'));
  } else {
    io.stderr.write(`cc-harness ${name}: ${regexRel} regex file not found; run init\n`);
  }
  const noTypesLine = regexExists && rules.types.length === 0;
  if (noTypesLine) {
    io.stderr.write(`cc-harness ${name}: ${regexRel} has no "# types:" line; the commits rule will point at the file instead of listing types\n`);
  }
  const vars = templateVars({ config, types: rules.types.length ? rules.types : DEFAULT_TYPES, scopes: rules.scopes, pluginVersion: version, projectName: path.basename(targetDir) });
  if (noTypesLine) {
    vars.COMMIT_TYPES = `see ${regexRel} (line 1 is the rule)`;
    vars.COMMIT_SCOPES_LINE = `see ${regexRel}`;
  }
  return { targetDir, version, vars, tdir: opts.templatesDir ?? templatesDir() };
}

export function syncRules(opts, io) {
  const ctx = loadSyncVars('sync-rules', opts, io);
  if (!ctx) return 1;
  const { targetDir, version, vars, tdir } = ctx;
  const writes = RULE_NAMES.map((n) => ({ rel: `.claude/rules/harness-${n}.md`, content: render(fs.readFileSync(path.join(tdir, 'rules', `harness-${n}.md.tmpl`), 'utf8'), vars), action: 'overwrite' }));
  writes.push({ rel: 'githooks/commit-msg', content: render(fs.readFileSync(path.join(tdir, 'githooks', 'commit-msg.tmpl'), 'utf8'), vars), action: 'overwrite', mode: 0o755 });
  applyWrites(targetDir, writes);
  io.stdout.write(`cc-harness sync-rules: refreshed ${writes.length} files to v${version}\n`);
  return 0;
}

// Re-render .github/workflows/harness.yml from harness.json (checks, ci.setupSteps,
// ci.extraSteps, the trailer setting) without touching anything else init wrote.
export function syncCi(opts, io) {
  const ctx = loadSyncVars('sync-ci', opts, io);
  if (!ctx) return 1;
  const { targetDir, vars, tdir } = ctx;
  const rel = '.github/workflows/harness.yml';
  applyWrites(targetDir, [{ rel, content: render(fs.readFileSync(path.join(tdir, 'ci.yml.tmpl'), 'utf8'), vars), action: 'overwrite' }]);
  io.stdout.write(`cc-harness sync-ci: refreshed ${rel}\n`);
  return 0;
}
