import path from 'node:path';
import { GUARD_NAMES, SUPPORTED_VERSION, isGuardEnabled } from './config.mjs';
import { render, templateVars, templatesDir, DEFAULT_TYPES } from './render.mjs';
import { shellFor } from './checks.mjs';

export const RULE_NAMES = ['testing', 'done', 'commits', 'models', 'harness'];
export const NODE_FLOOR = 18;

export function ruleStamp(text) {
  const stripped = String(text ?? '').replace(/^\uFEFF/, '');
  const m = /^<!--\s*cc-harness:\s*v([0-9][^\s]*)\s*-->/.exec(stripped);
  return m ? m[1] : null;
}

export function diagnose({ projectDir, loaded, exec, fs, pluginVersion, nodeVersion = process.version, platform = process.platform, env = process.env }) {
  const F = [];
  const ok = (t) => F.push({ level: 'ok', text: t });
  const warn = (t) => F.push({ level: 'warn', text: t });
  const error = (t) => F.push({ level: 'error', text: t });
  const exists = (rel) => fs.existsSync(path.resolve(projectDir, rel));

  const major = parseInt(String(nodeVersion).replace(/^v/, ''), 10);
  if (major >= NODE_FLOOR) ok(`node ${nodeVersion}`); else error(`node ${nodeVersion} is below the required ${NODE_FLOOR}`);

  const sh = shellFor({ platform, env, existsSync: fs.existsSync });
  if (sh) ok(`shell ${sh}`); else error('no POSIX shell found; install Git for Windows (its sh.exe) or use WSL; every check aborts until then');

  const git = exec('git --version', { cwd: projectDir });
  if (git.status === 0) ok('git available'); else error('git is not available on PATH');

  if (loaded.status === 'absent') { error('.claude/harness.json not found; run /cc-harness:init'); return finish(F); }
  if (loaded.status === 'invalid') { error(`.claude/harness.json is invalid: ${loaded.errors.join('; ')}`); return finish(F); }
  const c = loaded.config;
  ok(`config version ${c.version} (supported: ${SUPPORTED_VERSION}), preset ${c.preset}`);

  if (c.project.markerFile) {
    if (exists(c.project.markerFile)) ok(`marker file ${c.project.markerFile} present`);
    else warn(`marker file ${c.project.markerFile} not found; every guard stands down until it exists`);
  }

  if (isGuardEnabled(c, 'commit')) {
    const rf = c.guards.commit.regexFile;
    if (exists(rf)) ok(`commit regex file ${rf} present`); else warn(`commit regex file ${rf} not found; commits will be denied`);
    if (!exists('githooks/commit-msg')) warn('githooks/commit-msg not found; run /cc-harness:init, then: git config core.hooksPath githooks');
    else {
      const hp = exec('git config core.hooksPath', { cwd: projectDir });
      if (hp.status === 0 && path.resolve(projectDir, hp.output.trim()) === path.resolve(projectDir, 'githooks')) ok('git core.hooksPath=githooks');
      else warn('githooks/commit-msg exists but git core.hooksPath is not "githooks"; run: git config core.hooksPath githooks');
    }
  }

  for (const ch of c.checks) {
    if (ch.ifExists && !exists(ch.ifExists)) ok(`check ${ch.name} skipped (missing ${ch.ifExists})`);
  }

  for (const n of RULE_NAMES) {
    const rel = `.claude/rules/harness-${n}.md`;
    if (!exists(rel)) { warn(`${rel} missing; run /cc-harness:init or harness sync-rules`); continue; }
    const stamp = ruleStamp(fs.readFileSync(path.resolve(projectDir, rel), 'utf8'));
    if (stamp === pluginVersion) ok(`${rel} current`);
    else warn(`${rel} is stamped v${stamp ?? '?'} but the plugin is ${pluginVersion}; run harness sync-rules`);
  }

  // The workflow is rendered from harness.json; a config edit leaves it stale until sync-ci runs.
  // Only compared when the file exists: a project may have removed its CI on purpose.
  const wf = '.github/workflows/harness.yml';
  if (exists(wf)) {
    let expected = null;
    try {
      expected = render(fs.readFileSync(path.join(templatesDir(), 'ci.yml.tmpl'), 'utf8'), templateVars({ config: c, types: DEFAULT_TYPES, scopes: [], pluginVersion, projectName: path.basename(projectDir) }));
    } catch { /* unrenderable config: reported below */ }
    if (expected === null) warn(`${wf} could not be rendered from .claude/harness.json for comparison`);
    else if (fs.readFileSync(path.resolve(projectDir, wf), 'utf8') === expected) ok(`${wf} current`);
    else warn(`${wf} differs from what .claude/harness.json renders; run harness sync-ci`);
  }

  // The owned record lists the permission entries init wrote; each should still be in settings.
  const ownedRel = '.claude/harness.owned.json';
  const settingsRel = '.claude/settings.json';
  if (exists(ownedRel) && exists(settingsRel)) {
    try {
      const owned = JSON.parse(fs.readFileSync(path.resolve(projectDir, ownedRel), 'utf8')).permissions ?? {};
      const perms = JSON.parse(fs.readFileSync(path.resolve(projectDir, settingsRel), 'utf8')).permissions ?? {};
      const missing = [];
      for (const k of ['allow', 'ask', 'deny']) for (const e of owned[k] ?? []) if (!(perms[k] ?? []).includes(e)) missing.push(e);
      if (!missing.length) ok(`${ownedRel} matches ${settingsRel}`);
      else warn(`${missing.length} harness-owned permission entr${missing.length === 1 ? 'y is' : 'ies are'} missing from ${settingsRel} (${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ', …' : ''}); run init --force or re-add them`);
    } catch { warn(`${ownedRel} or ${settingsRel} is not valid JSON`); }
  }
  return finish(F);
}

function finish(findings) {
  const bad = findings.filter((f) => f.level !== 'ok');
  return { findings, summary: bad.length ? `${bad.length} finding(s) need attention` : 'all checks passed' };
}

export function formatStatus(report, { pluginVersion, config }) {
  const lines = [];
  const guards = config ? GUARD_NAMES.filter((g) => isGuardEnabled(config, g)).join(' ') : 'none';
  lines.push(`cc-harness v${pluginVersion} · preset ${config?.preset ?? '-'} · guards: ${guards}`);
  if (config) {
    const skipped = report.findings.filter((f) => /^check (\S+) skipped \(missing (.+)\)$/.test(f.text)).map((f) => f.text.replace(/^check (\S+) skipped \(missing (.+)\)$/, '$1, missing $2'));
    const names = config.checks.map((c) => (c.fast ? `${c.name}*` : c.name)).join(' ') || 'none';
    lines.push(`checks: ${names}${skipped.length ? ` (skipped: ${skipped.join('; ')})` : ''}   (* = fast, runs after every edit)`);
    lines.push(`stop gate: ${config.guards.stop.checks.join(' ') || 'none'} · max blocks ${config.guards.stop.maxBlocks}`);
  }
  const bad = report.findings.filter((f) => f.level !== 'ok');
  lines.push(bad.length ? `attention: ${bad.map((f) => f.text).join(' | ')}` : 'doctor: all checks passed');
  lines.push('disable a guard: set guards.<name>.enabled=false in .claude/harness.json · details: /cc-harness:doctor');
  return lines.join('\n') + '\n';
}
