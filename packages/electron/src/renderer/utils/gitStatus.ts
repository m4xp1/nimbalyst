import type { GitStatus } from '../store/atoms/gitOperations';

export function normalizeGitStatus(value: unknown): GitStatus | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<GitStatus>;
  if (
    typeof candidate.branch !== 'string'
    || candidate.branch.trim().length === 0
    || typeof candidate.ahead !== 'number'
    || typeof candidate.behind !== 'number'
    || typeof candidate.hasUncommitted !== 'boolean'
  ) {
    return null;
  }

  return {
    branch: candidate.branch.trim(),
    ahead: candidate.ahead,
    behind: candidate.behind,
    hasUncommitted: candidate.hasUncommitted,
    ...(typeof candidate.baseBranch === 'string' ? { baseBranch: candidate.baseBranch } : {}),
    ...(typeof candidate.isMerged === 'boolean' ? { isMerged: candidate.isMerged } : {}),
  };
}


/** Compare repository paths without conflating distinct nested repositories. */
export function sameGitRepository(a: string, b: string): boolean {
  const key=(path:string)=>{const value=path.replace(/\\/g,'/').replace(/\/+$/,'').replace(/^\/\/\?\//,'');return /^[a-z]:/i.test(value)||value.startsWith('//')?value.toLowerCase():value;};
  return key(a)===key(b);
}

/** A revisioned snapshot wins over every older in-flight legacy status read. */
export function watchGitStatus(api: Pick<Window['electronAPI'],'invoke'|'git'>, repoPath: string, onStatus: (status: GitStatus|null)=>void) {
  let disposed=false,generation=0,revision=-1;
  const refresh=async()=>{
    const request=++generation;
    try {const value=await api.invoke('git:status',repoPath);if(!disposed&&request===generation)onStatus(normalizeGitStatus(value));}
    catch(error){if(!disposed&&request===generation)console.error('[GitStatus] Refresh failed:',error);}
  };
  const stop=api.git?.onStatusChanged?.(event=>{
    if(!sameGitRepository(event.repoPath??event.workspacePath,repoPath))return;
    if(event.status){
      if(event.revision!==undefined){if(event.revision<=revision)return;revision=event.revision;}
      generation++;if(!disposed)onStatus(normalizeGitStatus(event.status));
    }else void refresh();
  });
  void refresh();
  return {refresh,dispose:()=>{disposed=true;generation++;stop?.();}};
}
