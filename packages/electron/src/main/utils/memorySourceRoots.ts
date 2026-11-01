import path from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import {getWorkspaceState,updateWorkspaceState} from './store';
import { searchPathKey, type WorkspaceSearchRoot } from './workspaceSearchRoots';

interface Snapshot {
  paths: string;
  requested: string;
  roots: WorkspaceSearchRoot[];
  checkedAt: number;
  pending?: Promise<void>;
}
const snapshots = new Map<string, Snapshot>();
interface DirectoryDescription {canonical:string;error?:string;code?:string;realpathMs:number;statMs:number;realpathCode?:string;fallbackDepth?:number;}
interface DirectoryProbe {id:string;startedAt:number;stage:'realpath'|'stat';promise:Promise<DirectoryDescription>;lateObservers?:Set<string>;}
const probes=new Map<string,DirectoryProbe>();let probeSequence=0;
function safeCode(failure:unknown):string|undefined{const code=(failure as {code?:unknown})?.code;return typeof code==='string'&&/^[A-Z][A-Z0-9_]{1,63}$/.test(code)?code:undefined;}
const lastReports=new Map<string,{at:number;suppressed:number}>();
function logCheck(event:Record<string,unknown>):void{
 const key=JSON.stringify([event.workspaceId,event.rootId,event.event,event.code,event.available,event.stage]),prior=lastReports.get(key),now=Date.now();
 if(event.previousAvailable===event.available&&prior&&now-prior.at<60000){prior.suppressed++;return;}
 lastReports.set(key,{at:now,suppressed:0});if(lastReports.size>512)lastReports.delete(lastReports.keys().next().value!);
 console.info('[MemorySourceCheck]',JSON.stringify({time:new Date().toISOString(),...event,...(prior?.suppressed?{suppressedChecks:prior.suppressed}:{})}));
}
function probeDirectory(absolute:string):DirectoryProbe{
 const key=searchPathKey(absolute),existing=probes.get(key);if(existing)return existing;
 const probe:DirectoryProbe={id:String(++probeSequence),startedAt:Date.now(),stage:'realpath',promise:null!};
 probe.promise=(async()=>{
  let current=absolute;const tail:string[]=[];let canonical=absolute;let realpathCode:string|undefined;
  for(;;){try{canonical=path.join(await realpath(current),...tail);break;}catch(failure){realpathCode=safeCode(failure);const parent=path.dirname(current);if(parent===current)break;tail.unshift(path.basename(current));current=parent;}}
  const realpathMs=Math.max(0,Date.now()-probe.startedAt);probe.stage='stat';const statStart=Date.now();
  try{if(!(await stat(canonical)).isDirectory())return{canonical,error:'Not a directory',code:'ENOTDIR',realpathCode,fallbackDepth:tail.length,realpathMs,statMs:Math.max(0,Date.now()-statStart)};
   return{canonical,realpathCode,fallbackDepth:tail.length,realpathMs,statMs:Math.max(0,Date.now()-statStart)};
  }catch(failure){return{canonical,error:'Source folder check failed',code:safeCode(failure),realpathCode,fallbackDepth:tail.length,realpathMs,statMs:Math.max(0,Date.now()-statStart)};}
 })().finally(()=>{probes.delete(key);});probes.set(key,probe);return probe;
}

/** Metadata reads never synchronously probe disks or walk every alias per root. */
export async function memorySourceRoots(workspace: string, paths: string[]): Promise<WorkspaceSearchRoot[]> {
  const key = searchPathKey(path.resolve(workspace));
  let snapshot = snapshots.get(key);
  const first = !snapshot;
  if (!snapshot) {
    snapshot = { paths: '', requested: '', roots: (getWorkspaceState(workspace).memoryRootIdentities??[]).map(root=>({...root,label:path.basename(root.path)||root.path,available:false,error:'Source folder has not been verified'})), checkedAt: 0 };
    snapshots.set(key, snapshot);
    if (snapshots.size > 128) {
      for (const [oldKey, old] of snapshots) {
        if (oldKey !== key && !old.pending) { snapshots.delete(oldKey); break; }
      }
    }
  }
  const signature = JSON.stringify(paths);
  snapshot.requested = signature;
  const configured = new Set(paths.map(value => searchPathKey(path.resolve(value))));
  // Detach takes effect before any asynchronous filesystem probe finishes.
  snapshot.roots = snapshot.roots.filter(root => (root.treePaths ?? [root.path]).some(value => configured.has(searchPathKey(path.resolve(value)))));
  const previousByAlias = new Map(snapshot.roots.flatMap(root =>
    (root.treePaths ?? [root.path]).map(alias => [searchPathKey(path.resolve(alias)), root] as const)));
  const needsRoots = [...configured].some(value => !previousByAlias.has(value));
  if (!snapshot.pending && (snapshot.paths !== signature || Date.now() - snapshot.checkedAt >= 1000)) {
    const current = snapshot;
    current.pending = (async () => {
      const described = await Promise.all(paths.map(async (value, index) => {
        const absolute = path.resolve(value);
        const prior = previousByAlias.get(searchPathKey(absolute));
        let timer: ReturnType<typeof setTimeout> | undefined;
        let canonical = prior?.path ?? absolute;
        let error: string | undefined;
        const probe=probeDirectory(absolute),startedAt=Date.now();let timedOut=false;let result:DirectoryDescription|undefined;
        try {
          result = await Promise.race([probe.promise, new Promise<never>((_, reject) => {
            timer = setTimeout(() => {timedOut=true;reject(new Error('Source folder check timed out'));}, 1000);
          })]);
          canonical=result.error?(prior?.path??result.canonical):result.canonical;error=result.error;
        } catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
        finally { if (timer) clearTimeout(timer); }
        const id = index === 0 ? null : prior?.id??'attached-' + createHash('sha256').update(searchPathKey(canonical)).digest('hex');
        const elapsedMs=Math.max(0,Date.now()-startedAt),changed=prior!==undefined&&prior.available!==!error;
        if(error||changed||elapsedMs>=250)logCheck({event:'result',workspaceId:createHash('sha256').update(key).digest('hex').slice(0,16),realpathCode:result?.realpathCode,fallbackDepth:result?.fallbackDepth,probeId:probe.id,rootId:id,stage:timedOut?probe.stage:'complete',elapsedMs,realpathMs:result?.realpathMs,statMs:result?.statMs,code:timedOut?'TIMEOUT':result?.code,deadlineMs:1000,timerDelayMs:timedOut?Math.max(0,elapsedMs-1000):undefined,available:!error,previousAvailable:prior?.available});
        if(timedOut){const observer=key+':'+id;probe.lateObservers??=new Set();if(!probe.lateObservers.has(observer)){probe.lateObservers.add(observer);void probe.promise.then(late=>logCheck({event:'late-result',workspaceId:createHash('sha256').update(key).digest('hex').slice(0,16),probeId:probe.id,rootId:id,elapsedMs:Math.max(0,Date.now()-startedAt),realpathMs:late.realpathMs,statMs:late.statMs,code:late.code,realpathCode:late.realpathCode,fallbackDepth:late.fallbackDepth,available:!late.error}));}}
        const attachmentRevision=getWorkspaceState(workspace).memoryAttachmentEpochs?.[path.resolve(value).replace(/[\\/]+$/,'')]??0;
        return { id, attachmentRevision, path: canonical, label: path.basename(canonical) || canonical, available: !error,
          ...(error ? { error } : {}), treePaths: [value] } satisfies WorkspaceSearchRoot;
      }));
      const unique = new Map<string, WorkspaceSearchRoot>();
      for (const root of described) {
        const rootKey = searchPathKey(root.path), existing = unique.get(rootKey);
        if (existing) existing.treePaths!.push(...root.treePaths);
        else unique.set(rootKey, root);
      }
      if (current.requested === signature) {
        current.roots = [...unique.values()];
        current.paths = signature;
        current.checkedAt = Date.now();
        const identities=current.roots.map(({id,path,treePaths})=>({id,path,treePaths:treePaths??[path]}));
        if(JSON.stringify(getWorkspaceState(workspace).memoryRootIdentities)!==JSON.stringify(identities))updateWorkspaceState(workspace,state=>{state.memoryRootIdentities=identities;});
      }
    })().finally(() => { current.pending = undefined; });
  }
  if (first||needsRoots) {
    await snapshot.pending;
    // An older background probe may have been invalidated by this attachment.
    // Only the latest requested membership can start its replacement probe.
    if(snapshot.requested===signature&&snapshot.paths!==signature)return memorySourceRoots(workspace,paths);
  }
  return snapshot.roots.map(root => ({ ...root, treePaths: [...root.treePaths ?? []] }));
}
