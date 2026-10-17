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

 it('indexes attached roots with independent rules, current reads, removal and persisted settings',async()=>{
  const base=mkdtempSync(path.join(tmpdir(),'memory-attached-')),root=path.join(base,'main'),link=path.join(base,'link'),dataDir=path.join(base,'state');
  mkdirSync(root);mkdirSync(link);mkdirSync(path.join(root,'docs'));mkdirSync(path.join(link,'docs'));mkdirSync(path.join(link,'archive'));
  writeFileSync(path.join(root,'docs/a.md'),'# Primary\nОсновнойКореньМаркер');
  writeFileSync(path.join(link,'docs/a.md'),'# Attached\nПодключенныйКореньМаркер');
  writeFileSync(path.join(link,'archive/a.md'),'# Archive\nАрхивПодключеннойПапкиМаркер');
  let roots=[{id:null as string|null,path:root,label:'main',available:true}];
  const services={workspacePath:root,extensionPath:root,dataDir,log:vi.fn(),getApiKey:async()=>({key:null}),registerMcpTools:async()=>({registered:[]}),memorySourceRoots:async()=>roots};
  let runtime=await activate({services});
  try {
   await vi.waitFor(async()=>expect((await runtime.methods.status() as any).indexing).toBe(false));
   roots=[...roots,{id:'attached-link',path:link,label:'link',available:true}];
   const found=await runtime.methods.search_project_knowledge({query:'ПодключенныйКореньМаркер',k:8}) as any;
   expect(found.chunks).toHaveLength(1);expect(found.chunks[0]).toMatchObject({sourcePath:'@attached-link/docs/a.md',refId:path.join(link,'docs/a.md'),rootLabel:'link',relativePath:'docs/a.md'});
   expect((await runtime.methods.search_project_knowledge({query:'АрхивПодключеннойПапкиМаркер'}) as any).chunks).toEqual([]);
   await runtime.methods.set_sources({rootId:'attached-link',include:['archive/**'],exclude:[]});
   expect((await runtime.methods.get_sources()).include).toEqual([]);
   expect(JSON.stringify(await runtime.methods.read_doc({path:'@attached-link/archive/a.md'}))).toContain('АрхивПодключеннойПапкиМаркер');
   expect(JSON.stringify(await runtime.methods.expand({sourcePath:'@attached-link/archive/a.md'}))).toContain('АрхивПодключеннойПапкиМаркер');
   writeFileSync(path.join(link,'archive/a.md'),'# Archive\nОбновленныйАрхивМаркер');
   await vi.waitFor(async()=>expect((await runtime.methods.search_project_knowledge({query:'ОбновленныйАрхивМаркер'}) as any).chunks).toHaveLength(1),{timeout:10000});
   const disk=await import('node:fs');
   disk.renameSync(path.join(link,'archive/a.md'),path.join(link,'archive/renamed.md'));
   await vi.waitFor(async()=>{
     const hits=(await runtime.methods.search_project_knowledge({query:'ОбновленныйАрхивМаркер'}) as any).chunks;
     expect(hits).toHaveLength(1);expect(hits[0].sourcePath).toBe('@attached-link/archive/renamed.md');
   },{timeout:10000});
   disk.unlinkSync(path.join(link,'archive/renamed.md'));
   await vi.waitFor(async()=>expect((await runtime.methods.search_project_knowledge({query:'ОбновленныйАрхивМаркер'}) as any).chunks).toEqual([]),{timeout:10000});
   writeFileSync(path.join(link,'archive/a.md'),'# Archive\nОбновленныйАрхивМаркер');
   await runtime.methods.set_sources({rootId:'attached-link',include:['archive/**'],exclude:['archive/**']});
   expect((await runtime.methods.search_project_knowledge({query:'ОбновленныйАрхивМаркер'}) as any).chunks).toEqual([]);
   await runtime.methods.set_sources({rootId:'attached-link',include:['archive/**'],exclude:[]});
   roots=roots.map(r=>r.id?{...r,available:false}:r);
   expect((await runtime.methods.search_project_knowledge({query:'ОбновленныйАрхивМаркер'}) as any).chunks).toEqual([]);
   expect((await runtime.methods.status() as any).sourceRootErrors).toHaveLength(1);
   roots=roots.filter(r=>!r.id);
   expect((await runtime.methods.search_project_knowledge({query:'ПодключенныйКореньМаркер'}) as any).chunks).toEqual([]);
   await expect(runtime.methods.get_sources({rootId:'attached-link'})).rejects.toThrow(/detached/);
   await runtime.deactivate();
   roots=[...roots,{id:'attached-link',path:link,label:'link',available:true}];runtime=await activate({services});
   await vi.waitFor(async()=>expect((await runtime.methods.status() as any).indexing).toBe(false));
   expect((await runtime.methods.get_sources({rootId:'attached-link'})).include).toEqual(['archive/**']);
   expect((await runtime.methods.search_project_knowledge({query:'ОбновленныйАрхивМаркер'}) as any).chunks).toHaveLength(1);
  }finally{await runtime.deactivate();rmSync(base,{recursive:true,force:true});}
 });
});
