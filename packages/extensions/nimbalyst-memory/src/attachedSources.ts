import fs from 'node:fs';
import path from 'node:path';
import { defaultSources, sourcesWithRules, normalizeSourceRules, type SourceRules, type SourceSet } from '../engine/dist/index.js';
export interface MemorySourceRoot { id: string | null; path: string; label: string; available: boolean; error?: string; }
export type AttachedRules = Record<string, SourceRules>;
export function readAttachedRules(dataDir: string): AttachedRules {
  try {
    const value=JSON.parse(fs.readFileSync(path.join(dataDir,'root-sources.json'),'utf8'));
    if(value.version!==1 || !value.roots || typeof value.roots!=='object')throw Error('Invalid attached source settings');
    return Object.fromEntries(Object.entries(value.roots).map(([id,rules])=>[id,normalizeSourceRules(rules)]));
  } catch(error) { if((error as NodeJS.ErrnoException).code==='ENOENT')return {};throw error; }
}
export function writeAttachedRules(dataDir: string, roots: AttachedRules): void {
  const file=path.join(dataDir,'root-sources.json');
  fs.writeFileSync(file+'.tmp',JSON.stringify({version:1,roots},null,2)+'\n');fs.renameSync(file+'.tmp',file);
}
export function attachedSources(factsDir:string,workspacePath:string,roots:MemorySourceRoot[],primary:SourceRules,rules:AttachedRules):SourceSet[] {
  const base=sourcesWithRules(defaultSources(factsDir,workspacePath),primary);
  for(const root of roots) {
    if(root.id===null || !root.available)continue;
    const selected=rules[root.id]??{version:1 as const,include:[],exclude:[]};
    const sets=sourcesWithRules(defaultSources(factsDir,root.path).filter(set=>!set.root),selected);
    for(const set of sets)base.push({...set,exclude:selected.exclude,root:{id:root.id,path:root.path,personal:true}});
  }
  return base;
}
