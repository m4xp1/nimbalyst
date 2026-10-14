// @vitest-environment node
import {afterEach,describe,expect,it,vi} from 'vitest';
vi.mock('../startupMaintenanceGate',()=>({runWhenFirstUsable:(_label:string,fn:()=>unknown)=>{void fn();}}));
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {MemoryEngine} from '../../../../../extensions/nimbalyst-memory/engine/src/engine';
import {FakeEmbedder} from '../../../../../extensions/nimbalyst-memory/engine/src/__tests__/fakeEmbedder';
import {TranscriptRuntime} from '@nimbalyst/runtime/ai/server/transcript/TranscriptRuntime';
import {TranscriptMigrationRepository} from '@nimbalyst/runtime/storage/repositories/TranscriptMigrationRepository';
import type {RawMessage} from '@nimbalyst/runtime/ai/server/transcript/TranscriptTransformer';
const h=vi.hoisted(()=>({enabled:true,metas:[] as any[],listeners:[] as any[],request:vi.fn(),root:'',running:false}));
vi.mock('../../extensions/PrivilegedExtensionHost',()=>({getPrivilegedExtensionHost:()=>({
  list:()=>h.running?[{extensionId:'com.nimbalyst.memory',moduleId:'memory-engine',workspacePath:h.root,state:{status:'running'}}]:[],
  getState:()=>({status:h.running?'running':'stopped'}),onStateChanged:(fn:any)=>{h.listeners.push(fn);return ()=>{};},request:h.request,
})}));
vi.mock('../../window/WindowManager',()=>({documentServices:new Map()}));
vi.mock('../../utils/store',()=>({getAppSetting:()=>h.enabled,setAppSetting:(_key:string,value:boolean)=>{h.enabled=value;}}));
vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository',()=>({AISessionsRepository:{list:async()=>h.metas}}));
import {SemanticCatalogService} from '../SemanticCatalogService';
import {notifySessionMemoryChange} from '../sessionMemoryEvents';
import {readMemorySessionContent} from '../sessionMemoryContent';
let engine:MemoryEngine,catalog:SemanticCatalogService;
afterEach(async()=>{catalog?.stop();await engine?.close();TranscriptMigrationRepository.clearService();if(h.root)rmSync(h.root,{recursive:true,force:true});h.listeners=[];h.running=false;vi.restoreAllMocks();});
async function setup() {
  h.root=mkdtempSync(path.join(tmpdir(),'session-memory-search-'));h.enabled=true;h.running=false;
  h.metas=[{id:'parent',title:'Chat',provider:'openai-codex',workspaceId:h.root,isArchived:false,parentSessionId:null},
    {id:'child',title:'Child',provider:'openai-codex',workspaceId:h.root,isArchived:false,parentSessionId:'parent'}];
  const rows:RawMessage[]=[];
  const runtime=new TranscriptRuntime({getMessages:async(sid,after=0)=>rows.filter(r=>r.sessionId===sid&&r.id>after)});
  TranscriptMigrationRepository.setService(runtime as any);
  engine=MemoryEngine.create({root:h.root,dbPath:path.join(h.root,'memory.db'),factsDir:'facts',sources:[]},new FakeEmbedder());
  h.request.mockImplementation(async({method,params}:any)=>{
    if(method==='ingestRecords')return engine.ingestRecords(params.records);
    if(method==='removeRecords')return engine.removeRecords(params.ids);
    if(method==='clearSessionRecords')return engine.clearSessionRecords();
    if(method==='completeSessionProjection')return engine.completeSessionProjection(params.version,params.parents);
    return {ready:true,...engine.status()};
  });
  catalog=new SemanticCatalogService(meta=>readMemorySessionContent(meta,runtime));catalog.start();h.running=true;
  for(const fn of h.listeners)fn({extensionId:'com.nimbalyst.memory',moduleId:'memory-engine',workspacePath:h.root,state:{status:'running'}});
  await vi.waitFor(()=>expect(engine.expand('session:parent',[])?.text).toContain('Chat'));
  const append=(sid:string,text:string,direction:'input'|'output')=>{
    rows.push({id:rows.length+1,sessionId:sid,source:'openai-codex',direction,createdAt:new Date(),metadata:{transport:'app-server'},
      content:JSON.stringify(direction==='input'?{prompt:text}:{method:'item/completed',params:{item:{id:'reply'+rows.length,type:'agentMessage',text}}})});
    notifySessionMemoryChange(sid,direction);
  };
  const sparse=async(q:string)=>(await engine.search(q,100)).filter(hit=>hit.signals?.sparse);
  return {append,sparse,runtime};
}
describe('live normalized session catalogue → actual Memory search',()=>{
  it('backfills more than 400 sessions and removes a deleted source without disturbing its siblings',async()=>{
    const {append,sparse}=await setup();
    for(let i=0;i<405;i++)h.metas.push({id:'history'+i,title:'History',provider:'openai-codex',isArchived:false,parentSessionId:null});
    append('history404','ПоследняяИсторияМаркер','input');
    await catalog.rebuildSessions(h.root);
    expect((await sparse('ПоследняяИсторияМаркер')).map(hit=>hit.refId)).toEqual(['history404']);
    h.metas=h.metas.filter(meta=>meta.id!=='history404');notifySessionMemoryChange('history404','deleted');
    await vi.waitFor(async()=>expect(await sparse('ПоследняяИсторияМаркер')).toEqual([]),{timeout:3000});
    expect(engine.expand('session:parent',[])).not.toBeNull();
  });
  it('refreshes empty Chat within three seconds, includes replies, and keeps child identity',async()=>{
    const {append,sparse}=await setup();const start=Date.now();
    append('parent','РусскийРодительМаркер','input');append('parent','ОтветРодителяМаркер','output');
    append('child','ДочерняяСессияМаркер','input');
    await vi.waitFor(async()=>expect((await sparse('ОтветРодителяМаркер')).map(h=>h.refId)).toEqual(['parent']),{timeout:3000});
    expect(Date.now()-start).toBeLessThan(3000);
    const child=await sparse('ДочерняяСессияМаркер');expect(child.map(h=>h.refId)).toEqual(['child']);expect(child[0].parentSessionId).toBe('parent');
    expect(engine.expand('session:parent',[])?.text).not.toContain('ДочерняяСессияМаркер');
  });
  it('evicts failed or archived bodies and rebuilds only session sources including legacy orphans',async()=>{
    const {append,sparse,runtime}=await setup();
    append('parent','СохранённыйМаркер','input');
    await vi.waitFor(async()=>expect(await sparse('СохранённыйМаркер')).toHaveLength(1),{timeout:3000});
    await engine.ingestRecords([{id:'session:orphan',sourceClass:'sessions',refType:'session',refId:'orphan',text:'СтарыйМаркер'},
      {id:'tracker:native',sourceClass:'trackers',refType:'tracker',refId:'native',text:'КарточкаМаркер'}]);
    const failure=vi.spyOn(runtime,'getViewMessages').mockRejectedValueOnce(new Error('unreadable'));
    await expect(catalog.rebuildSessions(h.root)).rejects.toThrow();expect(engine.expand('session:parent',[])).toBeNull();
    expect(catalog.sessionIndexingError()).not.toBeNull();failure.mockRestore();
    await catalog.rebuildSessions(h.root);expect(engine.expand('session:orphan',[])).toBeNull();
    expect(await sparse('КарточкаМаркер')).toHaveLength(1);expect(await sparse('СохранённыйМаркер')).toHaveLength(1);
    h.metas[0].isArchived=true;notifySessionMemoryChange('parent','metadata');
    await vi.waitFor(async()=>expect(await sparse('СохранённыйМаркер')).toEqual([]),{timeout:3000});
    await catalog.setSessionsEnabled(false);expect(engine.expand('session:child',[])).toBeNull();expect(await sparse('КарточкаМаркер')).toHaveLength(1);
  });
});
