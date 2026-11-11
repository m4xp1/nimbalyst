/** Lexical comparison only; the host remains responsible for repository/realpath security. */
function resolvedCommitPath(input:string,base:string):string {
 let value=input.replace(/\\/g,'/');if(/^[A-Za-z]:[^/]/.test(value))return'';
 if(!value.startsWith('/')&&!/^[A-Za-z]:\//.test(value))value=base.replace(/\\/g,'/').replace(/\/+$/,'')+'/'+value;
 const unc=value.startsWith('//'),prefix=unc?'//':value.startsWith('/')?'/':'',parts:string[]=[],minimum=unc?2:/^[A-Za-z]:/.test(value)?1:0;
 for(const part of value.split('/')){if(!part||part==='.')continue;if(part==='..'){if(parts.length>minimum)parts.pop();continue;}parts.push(part);}
 return prefix+parts.join('/');
}
export function commitPathKey(input:string,base:string):string {const value=resolvedCommitPath(input,base);return value.startsWith('//')||/^[A-Za-z]:/.test(value)?value.toLowerCase():value;}
export function relativeCommitPath(input:string,base:string):string {const value=resolvedCommitPath(input,base),root=resolvedCommitPath(base,base);return value.slice(root.replace(/\/+$/,'').length+1);}
export function filesWithinCommitRoots(files: readonly string[], roots: readonly string[], base: string): string[] {
  const allowed = roots.map(root => commitPathKey(root, base)).filter(Boolean);
  const seen = new Set<string>();
  return files.filter(file => {
    const key = commitPathKey(file, base);
    if (!key || seen.has(key) || !allowed.some(root => key === root || key.startsWith(root.replace(/\/+$/, '') + '/'))) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function eligibleCommitPaths(files: readonly string[], uncommitted: readonly string[], roots: readonly string[], base: string): string[] {
  const dirty = new Set(uncommitted.map(file => commitPathKey(file, base)));
  return filesWithinCommitRoots(files.filter(file => dirty.has(commitPathKey(file, base))), roots, base);
}
export function selectedCommitPaths(selection:readonly string[],visible:readonly string[],uncommitted:readonly string[],roots:readonly string[],base:string):string[]{
 const selected=new Set(selection.map(file=>commitPathKey(file,base)));return eligibleCommitPaths(visible,uncommitted,roots,base).filter(file=>selected.has(commitPathKey(file,base)));
}

/** Apply an authoritative status response only to the files it actually checked. */
export function reconcileCommitStatus(
  existing: readonly string[],
  status: Record<string, { status: string; gitStatusCode?: string }>,
  base: string,
): string[] {
  const checked = new Set(Object.keys(status).map(file => commitPathKey(file, base)));
  const next = existing.filter(file => !checked.has(commitPathKey(file, base)));
  for (const [file, value] of Object.entries(status)) {
    // Session history assigns a synthetic untracked status to paths with no Git repository.
    if (value.gitStatusCode && value.status !== 'unchanged') {
      next.push(resolvedCommitPath(file, base));
    }
  }
  return [...new Map(next.map(file => [commitPathKey(file, base), file])).values()];
}
