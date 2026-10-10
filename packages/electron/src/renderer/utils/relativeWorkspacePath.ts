/** Clipboard-only path: relative to the deepest owning root, never a virtual URI. */
export function relativeWorkspacePath(filePath: string, roots: readonly string[]): string | null {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(filePath) && !/^[a-z]:[\\/]/i.test(filePath)) return null;
  const slash = (value: string) => value.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/$/, '');
  const path = slash(filePath);
  const insensitive = /^[a-z]:\//i.test(path) || filePath.startsWith('\\\\');
  const compare = (value: string) => insensitive ? value.toLowerCase() : value;
  const owning = roots.map(slash).filter(root => compare(path) === compare(root) || compare(path).startsWith(compare(root) + '/'))
    .sort((a, b) => b.length - a.length)[0];
  if (!owning) return null;
  return path.length === owning.length ? '.' : path.slice(owning.length + 1);
}
