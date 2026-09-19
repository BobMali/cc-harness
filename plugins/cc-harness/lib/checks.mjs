import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const OUTPUT_LINES = 60;

export function selectChecks(config, { scope = 'fast' } = {}) {
  return scope === 'all' ? config.checks : config.checks.filter((c) => c.fast === true);
}

// The POSIX shell checks run through: /bin/sh everywhere but Windows, where Git for Windows'
// sh.exe is looked up on PATH and in its usual install locations. null means no shell.
export function shellFor({ platform = process.platform, env = process.env, existsSync = fs.existsSync } = {}) {
  if (platform !== 'win32') return '/bin/sh';
  const pathVar = env.PATH ?? env.Path ?? env.path ?? '';
  const candidates = pathVar.split(';').filter(Boolean).map((d) => path.win32.join(d, 'sh.exe'));
  const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, 'Programs')].filter(Boolean);
  for (const r of roots) candidates.push(path.win32.join(r, 'Git', 'bin', 'sh.exe'));
  return candidates.find((c) => existsSync(c)) ?? null;
}

export const NO_SHELL = 'check aborted: no POSIX shell found; install Git for Windows or use WSL';

export function defaultExec(cmd, { cwd, timeoutMs = 540_000, shell = shellFor() } = {}) {
  if (shell === null) return { status: 1, output: NO_SHELL };
  const r = spawnSync(shell, ['-c', cmd], {
    cwd, encoding: 'utf8', timeout: timeoutMs,
    env: { ...process.env, CI: process.env.CI ?? '1', FORCE_COLOR: '0', NO_COLOR: '1' },
    maxBuffer: 16 * 1024 * 1024,
  });
  const partial = (r.stdout ?? '') + (r.stderr ?? '');
  const output = r.error ? `check aborted: ${r.error.code ?? r.error.message}\n${partial}` : partial;
  return { status: r.status ?? 1, output };
}

export function runChecks(checks, { projectDir, exec, fs }) {
  const skipped = [];
  for (const c of checks) {
    if (c.ifExists && !fs.existsSync(path.resolve(projectDir, c.ifExists))) { skipped.push(c.name); continue; }
    const r = exec(c.cmd, { cwd: projectDir });
    if (r.status !== 0) return { ok: false, failed: { name: c.name, cmd: c.cmd, status: r.status, output: tail(r.output, OUTPUT_LINES) }, skipped };
  }
  return { ok: true, skipped };
}

export function tail(text, n) {
  const lines = String(text ?? '').replace(/\s+$/, '').split('\n');
  return lines.slice(-n).join('\n');
}

export function formatFailure(f) {
  return `cc-harness check "${f.name}" failed (exit ${f.status}): ${f.cmd}\n${f.output}\nFix this before continuing. Do not start new work.`;
}
