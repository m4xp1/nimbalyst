/** Post-commit notifications; listeners only enqueue work and never affect persistence. */
export interface SessionMemoryChange { sessionId: string; kind: 'input' | 'output' | 'metadata' | 'access' | 'deleted' }
const listeners = new Set<(change: SessionMemoryChange) => void>();
const invalidationListeners=new Set<(workspace?:string)=>void>();
export function watchSessionMemoryInvalidation(listener:(workspace?:string)=>void):()=>void {
  invalidationListeners.add(listener);return ()=>{invalidationListeners.delete(listener);};
}
export function invalidateSessionMemoryReads(workspace?:string):void {
  for(const listener of invalidationListeners)listener(workspace);
}
let rebuild:((workspace:string)=>Promise<void>)|null=null;
export function registerSessionMemoryRebuilder(callback:(workspace:string)=>Promise<void>):()=>void {
  rebuild=callback;return ()=>{if(rebuild===callback)rebuild=null;};
}
export async function rebuildSessionMemory(workspace:string):Promise<void> {
  if(!rebuild)throw new Error('Session catalogue is not running');
  await rebuild(workspace);
}
export function watchSessionMemoryChanges(listener: (change: SessionMemoryChange) => void): () => void {
  listeners.add(listener); return () => { listeners.delete(listener); };
}
export function notifySessionMemoryChange(sessionId: string, kind: SessionMemoryChange['kind']): void {
  for (const listener of listeners) {
    try { listener({sessionId,kind}); } catch { console.warn('[Memory] session change listener failed'); }
  }
}
