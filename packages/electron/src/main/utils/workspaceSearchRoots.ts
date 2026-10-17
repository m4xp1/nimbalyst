import path from 'node:path';
import { realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
export interface WorkspaceSearchRoot { id: string | null; path: string; label: string; available: boolean; error?: string; }
export function canonicalSearchPath(value: string): string {
  try { return realpathSync.native(value); } catch { return path.resolve(value); }
}
export function searchPathKey(value: string): string {
  const absolute = canonicalSearchPath(value);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}
export function describeWorkspaceSearchRoots(paths: string[]): WorkspaceSearchRoot[] {
  const seen = new Set<string>();
  return paths.flatMap((value, index) => {
    const absolute = canonicalSearchPath(value), key = searchPathKey(absolute);
    if (seen.has(key)) return [];
    seen.add(key);
    let error: string | undefined;
    try { if (!statSync(absolute).isDirectory()) error = 'Not a directory'; } catch (e) { error = String(e); }
    return [{ id: index === 0 ? null : 'attached-' + createHash('sha256').update(key).digest('hex'), path: absolute,
      label: path.basename(absolute) || absolute, available: !error, ...(error ? {error} : {}) }];
  });
}
export function owningSearchRoot(roots: WorkspaceSearchRoot[], file: string): WorkspaceSearchRoot | undefined {
  const key = searchPathKey(file);
  const candidates = roots.filter(root => { const base=searchPathKey(root.path); return key===base || key.startsWith(base+path.sep); });
  return candidates.find(root => root.id === null) ?? candidates.sort((a,b)=>b.path.length-a.path.length)[0];
}
