// @vitest-environment node
import { describe,it,expect,vi } from 'vitest';import { mkdtempSync,mkdirSync,writeFileSync,rmSync } from 'node:fs';import { tmpdir } from 'node:os';import path from 'node:path';
import { activate } from '../backend';
describe('source settings backend bridge',()=>{
 it('adds current-reading guidance only to desktop MCP session hits while preserving mixed search and reader identity',async()=>{
  const root=mkdtempSync(path.join(tmpdir(),'memory-reading-hint-'));
  mkdirSync(path.join(root,'docs'));writeFileSync(path.join(root,'docs/a.md'),'# Document\nОбщийПоисковыйМаркер ТолькоДокументМаркер');
  const read=vi.fn(async(p:any)=>({sessionId:p.sessionId,text:'## Assistant\nТекущийОтветМаркер',hasMore:false}));
  const runtime=await activate({services:{workspacePath:root,extensionPath:root,dataDir:path.join(root,'data'),log:vi.fn(),getApiKey:async()=>({key:null}),registerMcpTools:async()=>({registered:[]}),memorySessions:read}});
  try {
   await vi.waitFor(async()=>expect((await runtime.methods.status() as any).indexing).toBe(false));
   const doc=await runtime.methods.search_project_knowledge({query:'ТолькоДокументМаркер',k:10}) as any;
   expect(doc.chunks).toHaveLength(1);expect(doc).not.toHaveProperty('sessionReadHint');
   await runtime.methods.ingestRecords({records:[{id:'session:child',sourceClass:'sessions',refType:'session',refId:'child',parentSessionId:'parent',title:'Dialogue',text:'ОбщийПоисковыйМаркер ТолькоСессияМаркер'}]});
   await runtime.methods.completeSessionProjection({version:2,parents:{'session:child':'parent'}});
   const mixed=await runtime.methods.search_project_knowledge({query:'ОбщийПоисковыйМаркер',k:10}) as any;
   expect(new Set(mixed.chunks.map((c:any)=>c.refType))).toEqual(new Set(['session','doc-file']));
   expect(mixed.sessionReadHint).toEqual(expect.any(String));expect(mixed.capabilities).toEqual(doc.capabilities);expect(mixed.fallback).toEqual(doc.fallback);
   const hit=mixed.chunks.find((c:any)=>c.refType==='session');expect(hit).toMatchObject({sourcePath:'session:child',refId:'child',parentSessionId:'parent',sourceClass:'sessions',signals:{sparse:true}});
   expect(hit.score).toBeGreaterThan(0);expect(hit.citation).toContain('session:child');
   const only=await runtime.methods.search_project_knowledge({query:'ТолькоСессияМаркер',k:10}) as any;
   expect(only.chunks).toHaveLength(1);expect(only.sessionReadHint).toBe(mixed.sessionReadHint);
   expect((await runtime.methods.read_session({sessionId:hit.refId}) as any).text).toContain('ТекущийОтветМаркер');expect(read).toHaveBeenCalledWith({op:'read',sessionId:'child'});
   expect(await runtime.methods.globalSearch({query:'ОбщийПоисковыйМаркер',k:10})).not.toHaveProperty('sessionReadHint');
   expect(await runtime.methods.search_project_knowledge({query:'НесуществующийМаркер',k:10})).not.toHaveProperty('sessionReadHint');
  } finally {await runtime.deactivate();rmSync(root,{recursive:true,force:true});}
 });
 it('registers panel-only methods and survives source apply/rebuild without losing tool registration',async()=>{
  const root=mkdtempSync(path.join(tmpdir(),'memory-backend-')),dataDir=path.join(root,'data');mkdirSync(path.join(root,'docs'));writeFileSync(path.join(root,'docs/a.md'),'# Build\nСборка установщика');writeFileSync(path.join(root,'MAP.md'),'# Map\nУникальная карта');
  const register=vi.fn(async(tools:any[])=>({registered:tools.map(t=>t.name)}));
  const runtime=await activate({services:{workspacePath:root,extensionPath:root,dataDir,log:vi.fn(),getApiKey:async()=>({key:null}),registerMcpTools:register}});
  try{
   const tools=register.mock.calls[0][0];for(const name of ['get_sources','set_sources'])expect(tools.find(t=>t.name===name)?.panelOnly).toBe(true);expect(tools.find(t=>t.name==='status')?.panelOnly).toBeUndefined();
   expect(tools.find(t=>t.name==='read_session')?.inputSchema.required).toEqual(['sessionId']);
   await expect(runtime.methods.read_session({sessionId:'s'})).rejects.toThrow(/unavailable/);
   await vi.waitFor(async()=>expect((await runtime.methods.status() as any).indexing).toBe(false));
   expect(tools.find(t=>t.name==='preview_sources')).toBeUndefined();
   await runtime.methods.set_sources({include:['MAP.md'],exclude:[]});
   expect((await runtime.methods.status() as any).bySourceClass.custom).toBeGreaterThan(0);
   expect((await runtime.methods.get_sources()).include).toEqual(['MAP.md']);
   await Promise.all([runtime.methods.set_sources({include:[],exclude:[]}),runtime.methods.set_sources({include:['MAP.md'],exclude:[]})]);
   expect((await runtime.methods.get_sources()).include).toEqual(['MAP.md']);
   expect((await runtime.methods.status() as any).bySourceClass.custom).toBeGreaterThan(0);
   await runtime.methods.set_sources({include:[],exclude:[]});
   expect((await runtime.methods.get_sources()).include).toEqual([]);
   expect((await runtime.methods.status() as any).bySourceClass.custom ?? 0).toBe(0);
  }finally{await runtime.deactivate();rmSync(root,{recursive:true,force:true});}
 });
 it('Rebuild coordinates current session search through the broker without a blocking RPC cycle',async()=>{
  const root=mkdtempSync(path.join(tmpdir(),'memory-session-rebuild-'));
  let runtime:Awaited<ReturnType<typeof activate>>;
  const rebuild=vi.fn(async()=>{
   await runtime.methods.ingestRecords({records:[{id:'session:child',sourceClass:'sessions',refType:'session',refId:'child',parentSessionId:'parent',title:'Chat',text:'СвежийОтветМаркер'}]});
   await runtime.methods.completeSessionProjection({version:2,parents:{'session:child':'parent'}});
  });
  runtime=await activate({services:{workspacePath:root,extensionPath:root,dataDir:path.join(root,'data'),log:vi.fn(),getApiKey:async()=>({key:null}),registerMcpTools:async()=>({registered:[]}),memorySessions:rebuild}});
  try {
   await vi.waitFor(async()=>expect((await runtime.methods.status() as any).indexing).toBe(false));
   await runtime.methods.rebuild();expect(rebuild).toHaveBeenCalledOnce();
   const results=(await runtime.methods.globalSearch({query:'СвежийОтветМаркер',k:5}) as any).results;
   expect(results).toHaveLength(1);expect(results[0]).toMatchObject({refId:'child',parentSessionId:'parent',signals:{sparse:true}});
  } finally {await runtime.deactivate();rmSync(root,{recursive:true,force:true});}
 });
});
