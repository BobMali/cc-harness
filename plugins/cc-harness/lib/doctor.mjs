import path from 'node:path';
import { GUARD_NAMES, SUPPORTED_VERSION, isGuardEnabled } from './config.mjs';

export const RULE_NAMES = ['testing', 'done', 'commits', 'models', 'harness'];
export const NODE_FLOOR = 18;

export function ruleStamp(text) {
  const m = /^<!--\s*cc-harness:\s*v([0-9][^\s]*)\s*-->/m.exec(String(text ?? ''));
  return m ? m[1] : null;
}

export function diagnose({ projectDir, loaded, exec, fs, pluginVersion, nodeVersion = process.version }) {
  const F = [];
  const ok = (t) => F.push({ level: 'ok', text: t });
  const warn = (t) => F.push({ level: 'warn', text: t });
  const error = (t) => F.push({ level: 'error', text: t });
  const exists = (rel) => fs.existsSync(path.resolve(projectDir, rel));

  const major = parseInt(String(nodeVersion).replace(/^v/, ''), 10);
  if (major >= NODE_FLOOR) ok(`node ${nodeVersion}`); else error(`node ${nodeVersion} is below the required ${NODE_FLOOR}`);

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
      if (hp.status === 0 && hp.output.trim() === 'githooks') ok('git core.hooksPath=githooks');
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
