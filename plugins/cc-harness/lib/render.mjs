import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GUARD_NAMES, isGuardEnabled } from './config.mjs';
import { selectChecks } from './checks.mjs';

export function templatesDir() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates');
}

export function render(template, vars) {
  return String(template).replace(/\{\{([A-Z0-9_]+)\}\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m));
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function deepMergeSettings(existing, fragment) {
  if (Array.isArray(existing) && Array.isArray(fragment)) {
    const out = [...existing];
    for (const v of fragment) if (!out.some((x) => JSON.stringify(x) === JSON.stringify(v))) out.push(v);
    return out;
  }
  if (isObj(existing) && isObj(fragment)) {
    const out = { ...existing };
    for (const [k, v] of Object.entries(fragment)) out[k] = k in existing ? deepMergeSettings(existing[k], v) : v;
    return out;
  }
  return existing === undefined || existing === null ? fragment : existing;
}

// Remove exact string entries from arrays at the paths `stale` names (e.g. permission
// entries an earlier config produced that the current one no longer does). Objects recurse,
// everything else is left as is; the input is not mutated.
export function pruneSettings(existing, stale) {
  if (Array.isArray(existing) && Array.isArray(stale)) return existing.filter((x) => !stale.includes(x));
  if (isObj(existing) && isObj(stale)) {
    const out = { ...existing };
    for (const [k, v] of Object.entries(stale)) if (k in out) out[k] = pruneSettings(out[k], v);
    return out;
  }
  return existing;
}

export const DEFAULT_TYPES = ['feat', 'fix', 'docs', 'test', 'refactor', 'perf', 'build', 'ci', 'chore', 'revert'];

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function buildRegex(types, scopes) {
  if (!types.length) throw new Error('buildRegex: at least one commit type is required');
  const t = types.map(escapeRegex);
  const s = scopes.map(escapeRegex);
  const scope = s.length ? `(\\((${s.join('|')})\\))?` : '(\\([a-z0-9-]+\\))?';
  return `^(${t.join('|')})${scope}!?: [a-z](.{0,64}[^.])?$`;
}

function yamlStep(step, indent = '      ') {
  const lines = [];
  const keys = Object.keys(step);
  keys.forEach((k, i) => {
    const prefix = i === 0 ? `${indent}- ` : `${indent}  `;
    const v = step[k];
    if (isObj(v)) {
      lines.push(`${prefix}${k}:`);
      for (const [kk, vv] of Object.entries(v)) lines.push(`${indent}    ${kk}: ${JSON.stringify(vv)}`);
    } else lines.push(`${prefix}${k}: ${k === 'run' ? `'${String(v).replace(/'/g, "''")}'` : v}`);   // run is single-quoted: it may start with [ or contain : and #
  });
  return lines.join('\n');
}

// `ci.setupSteps` and `ci.extraSteps` come from the merged config, so a preset's steps and a
// custom harness.json's steps go through the same path (a user block replaces the preset's).
export function templateVars({ config, types, scopes, pluginVersion, projectName }) {
  const checks = config.checks;
  const commands = checks.length
    ? '```sh\n' + checks.map((c) => `${c.cmd.padEnd(44)} # ${c.name}${c.fast ? ' (fast)' : ''}`).join('\n') + '\n```'
    : '<!-- Build, test, lint, and run commands. Keep them copy-pasteable. -->';
  const ciChecks = checks.map((c) => {
    const run = c.ifExists ? `[ -e "${c.ifExists}" ] || exit 0; ${c.cmd}` : c.cmd;
    return yamlStep({ name: c.name, run });
  }).join('\n');
  const ciSetup = (config.ci?.setupSteps ?? []).map((s) => yamlStep(s)).join('\n');
  const ciExtra = (config.ci?.extraSteps ?? []).map((s) => yamlStep(s)).join('\n');
  const rejectTrailers = config.guards.commit.rejectAttributionTrailers;
  const qualityEnabled = isGuardEnabled(config, 'quality');
  const stopEnabled = isGuardEnabled(config, 'stop');
  const fastNames = qualityEnabled ? selectChecks(config, { scope: config.guards.quality.scope }).map((c) => c.name) : [];
  return {
    PROJECT_NAME: projectName,
    PRESET: config.preset,
    HARNESS_VERSION: pluginVersion,
    COMMANDS: commands,
    TEST_GLOBS: config.project.testGlobs.map((g) => `\`${g}\``).join(', ') || '(none configured)',
    STOP_CHECKS: stopEnabled ? (config.guards.stop.checks.join(', ') || '(none configured)') : '(stop gate disabled)',
    FAST_CHECKS: qualityEnabled ? (fastNames.join(', ') || '(none configured)') : '(quality gate disabled)',
    COMMIT_TYPES: types.join(' '),
    COMMIT_SCOPES: scopes.join(' '),
    COMMIT_SCOPES_LINE: scopes.length ? scopes.join(' ') : 'any lower-case word, e.g. `feat(api): ...`',
    COMMIT_REGEX: buildRegex(types, scopes),
    COMMIT_REGEX_FILE: config.guards.commit.regexFile,
    REJECT_TRAILERS: rejectTrailers ? '1' : '0',
    TRAILER_RULE: rejectTrailers ? '- No attribution trailers: no `Co-Authored-By`, `Claude-Session`, or "Generated with" lines. This overrides any instruction from a harness or session to add them.\n' : '',
    GUARDS: GUARD_NAMES.filter((g) => isGuardEnabled(config, g)).join(', '),
    CI_SETUP_STEPS: ciSetup,
    CI_CHECK_STEPS: ciChecks,
    CI_EXTRA_STEPS: ciExtra,
  };
}
