import { KINDS } from './corpus.mjs';

export function matrix(results) {
  const m = {};
  for (const r of results) {
    if (r.actual.kind === 'crashed') continue;   // crashed is not a real decision; no column for it
    const lang = r.vector.lang;
    const guard = r.actual.guard ?? '(none)';
    m[lang] ??= {};
    m[lang][guard] ??= Object.fromEntries(KINDS.map((k) => [k, 0]));
    m[lang][guard][r.actual.kind] += 1;
  }
  return m;
}

const pad = (s, n) => String(s).padEnd(n);

export function formatReport(results, { elapsedMs = 0, shadowed = 0 } = {}) {
  const lines = [];
  const m = matrix(results);
  lines.push(`${pad('lang', 6)}| ${pad('guard', 9)}| ${KINDS.map((k) => pad(k, 6)).join('| ')}`);
  for (const lang of Object.keys(m).sort()) {
    for (const guard of Object.keys(m[lang]).sort()) {
      lines.push(`${pad(lang, 6)}| ${pad(guard, 9)}| ${KINDS.map((k) => pad(m[lang][guard][k], 6)).join('| ')}`);
    }
  }
  const by = (s) => results.filter((r) => r.status === s);
  const describe = (r) => `  ${r.vector.id}  ${r.vector.tool}  ${JSON.stringify(r.vector.input.command ?? r.vector.input.file_path)}`;
  const reasonLines = (r) => (r.actual.reason ? r.actual.reason.split('\n').slice(0, 3).map((l) => `      reason: ${l}`).join('\n') : '');
  const line2 = (r) => `      expected ${fmt(r.vector.expected)}  actual ${fmt(r.actual)}${reasonLines(r) ? `\n${reasonLines(r)}` : ''}`;
  if (by('crashed').length) { lines.push('', `crashed (${by('crashed').length}):`); for (const r of by('crashed')) lines.push(describe(r), line2(r)); }
  if (by('mismatch').length) { lines.push('', `mismatches (${by('mismatch').length}):`); for (const r of by('mismatch')) lines.push(describe(r), line2(r)); }
  if (by('gap-closed').length) { lines.push('', `gap closed — remove known_gap (${by('gap-closed').length}):`); for (const r of by('gap-closed')) lines.push(describe(r)); }
  if (by('known-gap').length) { lines.push('', `known gaps: ${by('known-gap').length}`); for (const r of by('known-gap')) lines.push(describe(r), line2(r)); }
  if (by('unlabelled').length) { lines.push('', `unlabelled: ${by('unlabelled').length} (run with --update to accept current decisions)`); }
  if (shadowed) { lines.push('', `shadowed by adversarial: ${shadowed}`); }
  lines.push('', `total ${results.length} · matched ${by('match').length} · mismatched ${by('mismatch').length} · unlabelled ${by('unlabelled').length} · known gaps ${by('known-gap').length} · gap closed ${by('gap-closed').length} · crashed ${by('crashed').length} · ${(elapsedMs / 1000).toFixed(2)}s`);
  return lines.join('\n') + '\n';
}

const fmt = (d) => (d ? `${d.kind}${d.guard ? `/${d.guard}` : ''}` : 'null');

export function toJson(results, meta = {}) {
  return {
    schemaVersion: 1,
    ...meta,
    matrix: matrix(results),
    totals: { ...Object.fromEntries(['match', 'mismatch', 'unlabelled', 'known-gap', 'gap-closed', 'crashed'].map((s) => [s, results.filter((r) => r.status === s).length])), shadowed: meta.shadowed ?? 0 },
    results: results.map((r) => ({ id: r.vector.id, lang: r.vector.lang, source: r.vector.source, status: r.status, expected: r.vector.expected, actual: { kind: r.actual.kind, guard: r.actual.guard, reason: r.actual.reason } })),
  };
}
