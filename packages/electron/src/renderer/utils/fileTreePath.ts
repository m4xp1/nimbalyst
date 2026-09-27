/** Compare editor paths with file-tree paths without changing the paths used for I/O. */
export function normalizeFileTreePath(path: string): string {
  const slashed = path.replace(/\\/g, '/');
  const normalized = slashed.length > 1 ? slashed.replace(/\/+$/, '') : slashed;
  return /^[a-zA-Z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
}

export function fileTreePathsEqual(left: string, right: string): boolean {
  return normalizeFileTreePath(left) === normalizeFileTreePath(right);
}

/** Preserve tree selection when a tab uses forward slashes for the same file. */
export function selectedPathsContainFile(paths: ReadonlySet<string>, filePath: string): boolean {
  for (const path of paths) {
    if (fileTreePathsEqual(path, filePath)) return true;
  }
  return false;
}
