import fs from 'node:fs';
import path from 'node:path';
import { DEFAULTS, mergeConfig, loadPreset, loadConfig, defaultPresetsDir } from './config.mjs';
import { render, deepMergeSettings, buildRegex, templateVars, templatesDir, DEFAULT_TYPES } from './render.mjs';
import { parseRegexFile } from './commit-rules.mjs';
import { RULE_NAMES } from './doctor.mjs';
import { pluginRoot, pluginVersion } from './meta.mjs';

const PLUGIN_KEY = 'cc-harness@cc-harness';
const MARKET = 'cc-harness';
const LOCAL_SETTINGS = '.claude/settings.local.json';

export function defaultMarketplace() {
  const candidate = path.resolve(pluginRoot(), '..', '..');
  return fs.existsSync(path.join(candidate, '.claude-plugin', 'marketplace.json')) ? candidate : 'malek/cc-harness';
}

export function parseInitArgs(args, env) {
  const val = (flag) => { const i = args.indexOf(flag); if (i !== -1) return args[i + 1]; const eq = args.find((a) => a.startsWith(flag + '=')); return eq ? eq.slice(flag.length + 1) : undefined; };
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

const isRepo = (m) => /^[\w.-]+\/[\w.-]+$/.test(m);

function permissionFragment(config) {
  const allow = new Set(['Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git branch:*)']);
  for (const c of config.checks) allow.add(`Bash(${c.cmd.split(/\s+/)[0]}:*)`);
  const ask = new Set(['Bash(git push:*)', 'Bash(rm:*)']);
  for (const w of config.commands.write) {
    if (w.whenFlags) for (const f of w.whenFlags) ask.add(`Bash(${w.cmd} ${f}:*)`);
    else ask.add(`Bash(${w.cmd}:*)`);
  }
  const deny = ['Read(./.env)', 'Read(./.env.*)', 'Edit(./.env)', 'Edit(./.env.*)', 'Read(**/*.pem)', 'Edit(**/*.pem)', 'Read(**/credentials.*)', 'Read(~/.ssh/**)', 'Read(~/.gnupg/**)'];
  return { allow: [...allow], ask: [...ask], deny };
}

export function planInit(opts) {
  const presetsDir = opts.presetsDir ?? defaultPresetsDir();
  const tdir = opts.templatesDir ?? templatesDir();
  const version = opts.pluginVersion ?? pluginVersion();
  const preset = opts.preset === 'custom' ? {} : loadPreset(opts.preset, presetsDir);
  if (preset === null) throw new Error(`unknown preset "${opts.preset}"`);
  const config = mergeConfig(mergeConfig(DEFAULTS, preset), { preset: opts.preset });
  const vars = templateVars({ config, preset, types: opts.types, scopes: opts.scopes, pluginVersion: version, projectName: opts.projectName });
  const tpl = (rel) => fs.readFileSync(path.join(tdir, rel), 'utf8');
  const exists = (rel) => fs.existsSync(path.join(opts.targetDir, rel));
  const writes = [];
  const refusals = [];

  const harnessJson = opts.preset === 'custom'
    ? { version: 1, preset: 'custom', project: { markerFile: '', sourceGlobs: [], testGlobs: [] }, commands: { safe: [], write: [] }, checks: [], guards: { stop: { checks: [] } } }
    : { version: 1, preset: opts.preset };
  if (exists('.claude/harness.json') && !opts.force) refusals.push('.claude/harness.json exists; pass --force to overwrite it');
  writes.push({ rel: '.claude/harness.json', content: JSON.stringify(harnessJson, null, 2) + '\n', action: exists('.claude/harness.json') ? 'overwrite' : 'create' });

  const settingsFragment = { enabledPlugins: { [PLUGIN_KEY]: true }, permissions: permissionFragment(config) };
  const marketEntry = { [MARKET]: { source: isRepo(opts.marketplace) ? { source: 'github', repo: opts.marketplace } : { source: 'directory', path: path.resolve(opts.marketplace) } } };
  if (isRepo(opts.marketplace)) settingsFragment.extraKnownMarketplaces = marketEntry;
  writes.push(mergeJsonWrite(opts.targetDir, '.claude/settings.json', settingsFragment));
  if (!isRepo(opts.marketplace)) {
    writes.push(mergeJsonWrite(opts.targetDir, LOCAL_SETTINGS, { extraKnownMarketplaces: marketEntry }));
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

  writes.push({ rel: 'githooks/commit-msg', content: tpl('githooks/commit-msg'), action: exists('githooks/commit-msg') ? 'overwrite' : 'create', mode: 0o755 });
  const regexRel = config.guards.commit.regexFile;
  if (exists(regexRel) && !opts.force) refusals.push(`${regexRel} exists (you may have edited it); pass --force to overwrite it`);
  writes.push({ rel: regexRel, content: render(tpl('githooks/conventional-regex.txt.tmpl'), vars), action: exists(regexRel) ? 'overwrite' : 'create' });

  writes.push({ rel: '.github/workflows/harness.yml', content: render(tpl('ci.yml.tmpl'), vars), action: exists('.github/workflows/harness.yml') ? 'overwrite' : 'create' });

  const checklist = [
    'git config core.hooksPath githooks',
    `claude plugin marketplace add ${opts.marketplace}`,
    `claude plugin install ${PLUGIN_KEY}`,
    exists('CLAUDE.md') ? 'merge CLAUDE.harness.md into your CLAUDE.md, then delete it' : 'fill in the placeholders in CLAUDE.md',
    'restart Claude Code (or /reload) so the plugin hooks load; the session preflight will confirm',
  ];
  return { writes, refusals, checklist };
}

function mergeJsonWrite(targetDir, rel, fragment) {
  const abs = path.join(targetDir, rel);
  let existing = {};
  if (fs.existsSync(abs)) {
    try { existing = JSON.parse(fs.readFileSync(abs, 'utf8')); } catch (e) { throw new Error(`${rel} is not valid JSON: ${e.message}`); }
  }
  return { rel, content: JSON.stringify(deepMergeSettings(existing, fragment), null, 2) + '\n', action: fs.existsSync(abs) ? 'merge' : 'create' };
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

export function syncRules(opts, io) {
  const targetDir = path.resolve(opts.targetDir);
  const version = opts.pluginVersion ?? pluginVersion();
  const loaded = loadConfig(targetDir, opts.presetsDir ? { presetsDir: opts.presetsDir } : {});
  if (loaded.status !== 'ok') { io.stderr.write(`cc-harness sync-rules: ${loaded.status === 'absent' ? '.claude/harness.json not found; run init first' : loaded.errors.join('; ')}\n`); return 1; }
  const config = loaded.config;
  const preset = config.preset === 'custom' ? {} : (loadPreset(config.preset, opts.presetsDir ?? defaultPresetsDir()) ?? {});
  const regexAbs = path.join(targetDir, config.guards.commit.regexFile);
  const rules = fs.existsSync(regexAbs) ? parseRegexFile(fs.readFileSync(regexAbs, 'utf8')) : { types: DEFAULT_TYPES, scopes: [] };
  const vars = templateVars({ config, preset, types: rules.types.length ? rules.types : DEFAULT_TYPES, scopes: rules.scopes, pluginVersion: version, projectName: path.basename(targetDir) });
  const tdir = opts.templatesDir ?? templatesDir();
  const writes = RULE_NAMES.map((n) => ({ rel: `.claude/rules/harness-${n}.md`, content: render(fs.readFileSync(path.join(tdir, 'rules', `harness-${n}.md.tmpl`), 'utf8'), vars), action: 'overwrite' }));
  writes.push({ rel: 'githooks/commit-msg', content: fs.readFileSync(path.join(tdir, 'githooks', 'commit-msg'), 'utf8'), action: 'overwrite', mode: 0o755 });
  applyWrites(targetDir, writes);
  io.stdout.write(`cc-harness sync-rules: refreshed ${writes.length} files to v${version}\n`);
  return 0;
}
