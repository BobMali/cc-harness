import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SUPPORTED_VERSION = 1;
export const GUARD_NAMES = ['test', 'commit', 'quality', 'git', 'stop', 'preflight'];

export const BUILTIN_SAFE = [
  'cat', 'head', 'tail', 'less', 'more', 'grep', 'rg', 'egrep', 'fgrep', 'wc', 'ls', 'stat', 'file',
  'realpath', 'basename', 'dirname', 'sort', 'uniq', 'cut', 'tr', 'nl', 'column', 'bat', 'diff', 'cmp',
  'shasum', 'md5', 'md5sum', 'echo', 'printf', 'true', 'test', 'which', 'pwd', 'sed',
];

export const DEFAULTS = Object.freeze({
  version: 1,
  preset: 'custom',
  project: {
    markerFile: '',
    sourceGlobs: [],
    testGlobs: [],
    ignoreGlobs: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/.git/**'],
  },
  commands: {
    safe: [],
    write: [],
    runnerWrappers: ['npx', 'pnpm', 'yarn', 'bunx', 'bun', 'npm'],
  },
  checks: [],
  guards: {
    test: { enabled: true },
    commit: { enabled: true, regexFile: 'githooks/conventional-regex.txt', rejectAttributionTrailers: true },
    quality: { enabled: true, scope: 'fast' },
    git: { enabled: true },
    stop: { enabled: true, checks: [], maxBlocks: 3 },
    preflight: { enabled: true },
  },
  builtinSafe: BUILTIN_SAFE,
});

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function mergeConfig(base, over) {
  if (!isObj(base) || !isObj(over)) return over === undefined ? clone(base) : clone(over);
  const out = {};
  for (const k of new Set([...Object.keys(base), ...Object.keys(over)])) {
    if (!(k in over)) out[k] = clone(base[k]);
    else if (isObj(base[k]) && isObj(over[k])) out[k] = mergeConfig(base[k], over[k]);
    else out[k] = clone(over[k]);
  }
  return out;
}

function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

export function defaultPresetsDir() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'presets');
}

export function loadPreset(name, presetsDir = defaultPresetsDir()) {
  if (!/^[a-z0-9-]+$/.test(name)) return null;
  const file = path.join(presetsDir, `${name}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function configPath(projectDir) {
  return path.join(projectDir, '.claude', 'harness.json');
}

export function loadConfig(projectDir, { presetsDir = defaultPresetsDir() } = {}) {
  const file = configPath(projectDir);
  if (!fs.existsSync(file)) return { status: 'absent' };
  let user;
  try {
    user = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { status: 'invalid', errors: [`.claude/harness.json is not valid JSON: ${e.message}`] };
  }
  if (!isObj(user)) return { status: 'invalid', errors: ['.claude/harness.json must contain a JSON object'] };
  const presetName = user.preset ?? 'custom';
  let preset = {};
  if (presetName !== 'custom') {
    try {
      preset = loadPreset(presetName, presetsDir);
    } catch (e) {
      return { status: 'invalid', errors: [`preset "${presetName}" is not valid JSON: ${e.message}`] };
    }
    if (preset === null) return { status: 'invalid', errors: [`unknown preset "${presetName}" (no ${presetName}.json in presets/)`] };
  }
  const config = mergeConfig(mergeConfig(DEFAULTS, preset), user);
  const errors = validateConfig(config);
  return errors.length ? { status: 'invalid', errors, config } : { status: 'ok', config };
}

export function validateConfig(c) {
  const errors = [];
  const strArr = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
  if (c.version !== SUPPORTED_VERSION) errors.push(`version must be ${SUPPORTED_VERSION}, got ${JSON.stringify(c.version)}`);
  for (const k of ['sourceGlobs', 'testGlobs', 'ignoreGlobs']) {
    if (!strArr(c.project?.[k])) errors.push(`project.${k} must be an array of strings`);
  }
  if (typeof c.project?.markerFile !== 'string') errors.push('project.markerFile must be a string');
  if (!strArr(c.commands?.safe)) errors.push('commands.safe must be an array of strings');
  if (!strArr(c.commands?.runnerWrappers)) errors.push('commands.runnerWrappers must be an array of strings');
  if (!Array.isArray(c.commands?.write)) errors.push('commands.write must be an array');
  else c.commands.write.forEach((w, i) => {
    if (!isObj(w) || typeof w.cmd !== 'string') errors.push(`commands.write[${i}].cmd must be a string`);
    if (isObj(w)) {
      if ('whenFlags' in w && !strArr(w.whenFlags)) errors.push(`commands.write[${i}].whenFlags must be an array of strings`);
      if ('unlessFlags' in w && !strArr(w.unlessFlags)) errors.push(`commands.write[${i}].unlessFlags must be an array of strings`);
    }
  });
  const names = new Set();
  if (!Array.isArray(c.checks)) errors.push('checks must be an array');
  else c.checks.forEach((ch, i) => {
    if (!isObj(ch)) { errors.push(`checks[${i}] must be an object`); return; }
    if (typeof ch.name !== 'string' || !ch.name) errors.push(`checks[${i}].name must be a non-empty string`);
    else if (names.has(ch.name)) errors.push(`duplicate check name "${ch.name}"`);
    else names.add(ch.name);
    if (typeof ch.cmd !== 'string' || !ch.cmd) errors.push(`checks[${i}].cmd must be a non-empty string`);
    if ('fast' in ch && typeof ch.fast !== 'boolean') errors.push(`checks[${i}].fast must be a boolean`);
  });
  if ('ci' in c && c.ci !== undefined) {
    if (!isObj(c.ci)) errors.push('ci must be an object');
    else for (const k of ['setupSteps', 'extraSteps']) {
      if (k in c.ci && !(Array.isArray(c.ci[k]) && c.ci[k].every(isObj))) errors.push(`ci.${k} must be an array of step objects`);
    }
  }
  for (const g of GUARD_NAMES) {
    if (typeof c.guards?.[g]?.enabled !== 'boolean') errors.push(`guards.${g}.enabled must be a boolean`);
  }
  if (!['fast', 'all'].includes(c.guards?.quality?.scope)) errors.push(`guards.quality.scope must be "fast" or "all"`);
  if (typeof c.guards?.commit?.regexFile !== 'string') errors.push('guards.commit.regexFile must be a string');
  const mb = c.guards?.stop?.maxBlocks;
  if (!Number.isInteger(mb) || mb < 0 || mb > 7) errors.push('guards.stop.maxBlocks must be an integer between 0 and 7');
  if (!strArr(c.guards?.stop?.checks)) errors.push('guards.stop.checks must be an array of strings');
  else for (const n of c.guards.stop.checks) if (!names.has(n)) errors.push(`guards.stop.checks names unknown check "${n}"`);
  return errors;
}

export function isGuardEnabled(config, name) {
  return config.guards?.[name]?.enabled === true;
}

export function checksByName(config, names) {
  const byName = new Map(config.checks.map((c) => [c.name, c]));
  return names.map((n) => byName.get(n)).filter(Boolean);
}

export function relTo(projectDir, p) {
  const abs = path.isAbsolute(p) ? p : path.resolve(projectDir, p);
  return path.relative(projectDir, abs).replace(/\\/g, '/');
}

// True when a relTo() result points outside the project (a `..` prefix, or an absolute
// path when the two are on different drives).
export function isOutside(rel) {
  return rel === '..' || rel.startsWith('../') || path.isAbsolute(rel);
}
