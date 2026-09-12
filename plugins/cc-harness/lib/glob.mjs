const RE_SPECIAL = /[.+^${}()|[\]\\]/g;

export function globToRegExp(glob, { anchored = true } = {}) {
  let re = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 3; continue; }
        re += '.*'; i += 2; continue;
      }
      re += '[^/]*'; i += 1; continue;
    }
    if (c === '?') { re += '[^/]'; i += 1; continue; }
    re += c.replace(RE_SPECIAL, '\\$&');
    i += 1;
  }
  return new RegExp(anchored ? `^${re}$` : re);
}

function normalize(p) {
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '');
}

export function matchesGlob(relPath, glob) {
  const p = normalize(relPath);
  if (globToRegExp(glob).test(p)) return true;
  if (!glob.includes('/')) return globToRegExp(glob).test(p.slice(p.lastIndexOf('/') + 1));
  return false;
}

export function matchesAny(relPath, globs = []) {
  return globs.some((g) => matchesGlob(relPath, g));
}

export function mentionsAny(text, globs = []) {
  return globs.some((g) => globToRegExp(g, { anchored: false }).test(String(text)));
}
