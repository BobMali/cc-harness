import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const OUTPUT_LINES = 60;

export function selectChecks(config, { scope = 'fast' } = {}) {
  return scope === 'all' ? config.checks : config.checks.filter((c) => c.fast === true);
}

export function defaultExec(cmd, { cwd, timeoutMs = 540_000 } = {}) {
  // Escape hatch for the eval suite's CLI envelope sampling only: forces a check failure so a
  // sampled PostToolUse spawn observes the same "armed" decision the in-process stub produces.
  if (process.env.CC_HARNESS_EVAL_EXEC_FAIL === '1') return { status: 1, output: 'eval: forced failure' };
  const r = spawnSync('/bin/sh', ['-c', cmd], {
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
