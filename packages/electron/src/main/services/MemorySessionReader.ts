import {createHash,randomUUID} from 'node:crypto';
import type {SessionMeta} from '@nimbalyst/runtime';
import {AISessionsRepository} from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import {getAppSetting} from '../utils/store';
import {readMemorySessionContent,invalidateMemorySessionContent} from './sessionMemoryContent';
import {watchSessionMemoryInvalidation,watchSessionMemoryChanges} from './sessionMemoryEvents';

export interface MemorySessionReadRequest {sessionId:string;cursor?:string;maxChars?:number}
export interface MemorySessionReadResult {
  sessionId:string;parentSessionId:string|null;snapshotVersion:string;
  text:string;nextCursor:string|null;hasMore:boolean;
}
interface Dependencies {
  enabled:()=>boolean;list:(workspace:string)=>Promise<SessionMeta[]>;
  read:typeof readMemorySessionContent;now:()=>number;
}
interface Snapshot {workspace:string;sessionId:string;parentSessionId:string|null;version:string;text:string;expires:number}
interface Cursor {snapshot:Snapshot;offset:number}

/** Live host-scoped reads; the persisted search index is never a body fallback. */
export class MemorySessionReader {
  private cursors=new Map<string,Cursor>();
  private epochs=new Map<string,number>();
  private bump(key:string):void {this.epochs.set(key,(this.epochs.get(key)??0)+1);}
  private epoch(workspace:string,sessionId:string):string {return ['all','ws:'+workspace,'session:'+sessionId,'binding:'+workspace+'\0'+sessionId].map(key=>this.epochs.get(key)??0).join(':');}
  constructor(private readonly deps:Dependencies) {}
  invalidate(workspace?:string):void {
    this.bump(workspace?'ws:'+workspace:'all');
    for(const [key,cursor] of this.cursors)if(!workspace||cursor.snapshot.workspace===workspace)this.cursors.delete(key);
  }
  invalidateSession(sessionId:string,workspace?:string):void {
    this.bump(workspace?'binding:'+workspace+'\0'+sessionId:'session:'+sessionId);
    for(const [key,cursor] of this.cursors)if(cursor.snapshot.sessionId===sessionId&&(!workspace||cursor.snapshot.workspace===workspace))this.cursors.delete(key);
  }
  async read(workspace:string,request:MemorySessionReadRequest):Promise<MemorySessionReadResult> {
    if(!request||typeof request.sessionId!=='string'||!request.sessionId.trim())throw new Error('sessionId is required');
    const max=request.maxChars??12000;
    if(!Number.isInteger(max)||max<1000||max>24000)throw new Error('maxChars must be an integer from 1000 to 24000');
    if(!this.deps.enabled()){this.invalidate();throw new Error('Memory Sessions is disabled');}
    const generation=this.epoch(workspace,request.sessionId);
    const meta=(await this.deps.list(workspace)).find(m=>m.id===request.sessionId&&!m.isArchived);
    if(!meta){this.invalidateSession(request.sessionId,workspace);throw new Error('Session is deleted, archived, or unavailable in this workspace');}
    if(generation!==this.epoch(workspace,request.sessionId))throw new Error('Session read was revoked');
    let snapshot:Snapshot,offset=0;
    if(request.cursor!==undefined) {
      const entry=this.cursors.get(request.cursor);
      if(!entry||entry.snapshot.workspace!==workspace||entry.snapshot.sessionId!==request.sessionId)throw new Error('Invalid or revoked session cursor');
      if(entry.snapshot.expires<=this.deps.now()){this.cursors.delete(request.cursor);throw new Error('Session cursor expired; start a new read');}
      ({snapshot,offset}=entry);
    } else {
      const {text,parentSessionId}=await this.deps.read(meta);
      // A slow read cannot restore access after an option change or deletion.
      if(!this.deps.enabled()||!(await this.deps.list(workspace)).some(m=>m.id===meta.id&&!m.isArchived)||generation!==this.epoch(workspace,request.sessionId))throw new Error('Session access changed during read');
      snapshot={workspace,sessionId:meta.id,parentSessionId,text,version:createHash('sha256').update(JSON.stringify([meta.id,parentSessionId,text])).digest('hex'),expires:this.deps.now()+600000};
    }
    let end=Math.min(snapshot.text.length,offset+max);
    // UTF-16 offsets are internal only; never split a Unicode scalar.
    if(end<snapshot.text.length&&end>offset&&/[\uD800-\uDBFF]/.test(snapshot.text[end-1])&&/[\uDC00-\uDFFF]/.test(snapshot.text[end]))end--;
    const hasMore=end<snapshot.text.length;
    let nextCursor:string|null=null;
    if(hasMore) {
      for(const [key,value] of this.cursors)if(value.snapshot.expires<=this.deps.now())this.cursors.delete(key);
      // Bound retained pages; eviction gives an explicit revoked-cursor error.
      if(this.cursors.size>=512)this.cursors.delete(this.cursors.keys().next().value!);
      nextCursor=randomUUID();this.cursors.set(nextCursor,{snapshot,offset:end});
    }
    return {sessionId:snapshot.sessionId,parentSessionId:snapshot.parentSessionId,snapshotVersion:snapshot.version,text:snapshot.text.slice(offset,end),nextCursor,hasMore};
  }
}
const reader=new MemorySessionReader({
  enabled:()=>getAppSetting<boolean>('memoryIndexSessions')===true,
  list:workspace=>AISessionsRepository.list(workspace),now:Date.now,
  read:async meta=>{invalidateMemorySessionContent(meta.id);return readMemorySessionContent(meta);},
});
watchSessionMemoryInvalidation(workspace=>reader.invalidate(workspace));
watchSessionMemoryChanges(change=>{if(change.kind==='access'||change.kind==='deleted')reader.invalidateSession(change.sessionId);});
export const readCurrentMemorySession=(workspace:string,request:MemorySessionReadRequest)=>reader.read(workspace,request);
