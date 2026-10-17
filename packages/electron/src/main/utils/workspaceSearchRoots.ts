import path from 'node:path';
import { realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
export interface WorkspaceSearchRoot { id: string | null; path: string; label: string; available: boolean; error?: string; }
export function canonicalSearchPath(value: string): string {
  const absolute=path.resolve(value), tail:string[]=[];
  let current=absolute;
  for (;;) {
    try { return path.join(realpathSync.native(current),...tail); }
    catch {
      const parent=path.dirname(current);
      if(parent===current)return absolute;
      tail.unshift(path.basename(current));current=parent;
    }
  }
}
export function searchPathKey(value: string): string {
  const absolute = path.resolve(value);
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
export function owningSearchRoot(roots: WorkspaceSearchRoot[], file: string, canonicalize = true): WorkspaceSearchRoot | undefined {
  const key = searchPathKey(canonicalize ? canonicalSearchPath(file) : file);
  const candidates = roots.filter(root => { const base=searchPathKey(root.path); return key===base || key.startsWith(base+path.sep); });
  return candidates.find(root => root.id === null) ?? candidates.sort((a,b)=>b.path.length-a.path.length)[0];
}

/** Do not name a primary descendant explicitly to rg: that would bypass its ignore rules. */
export function scanSearchRoots(roots: WorkspaceSearchRoot[]): WorkspaceSearchRoot[] {
  const primary=roots.find(root=>root.id===null), base=primary && searchPathKey(primary.path);
  return roots.filter(root=>root.available && (!base || root.id===null || !searchPathKey(root.path).startsWith(base+path.sep)));
}
