// @vitest-environment node
import {treePolicyIncludes} from '../../engine/src/ruleProgram';
import { describe,it,expect,vi } from 'vitest';import { mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync,realpathSync } from 'node:fs';import { tmpdir } from 'node:os';import path from 'node:path';
import { activate } from '../backend';
import { Indexer,MemoryEngine } from '../../engine/dist/index.js';
describe('source settings backend bridge',()=>{
 it('exposes folder IDs and applies scopes to MCP, Quick Open and exact tracker lookup',async()=>{
  const base=realpathSync.native(mkdtempSync(path.join(tmpdir(),'memory-search-scopes-'))),root=path.join(base,'main'),link=path.join(base,'link');
  for(const dir of [root,link]){mkdirSync(path.join(dir,'docs'),{recursive:true});writeFileSync(path.join(dir,'docs/a.md'),'# Тест\nОбщийПоисковыйМаркер');}
  let roots=[{id:null as string|null,path:root,label:'main',available:true},{id:'attached-link',path:link,label:'link',available:true}];
  const runtime=await activate({services:{workspacePath:root,extensionPath:root,dataDir:path.join(base,'state'),log:vi.fn(),getApiKey:async()=>({key:null}),registerMcpTools:async()=>({registered:[]}),memorySourceRoots:async()=>roots}});
  try{
   await vi.waitFor(async()=>expect((await runtime.methods.status() as any).indexing).toBe(false));
   const sources=await runtime.methods.list_sources() as any;expect(sources.sources.map((s:any)=>s.rootId)).toEqual([null,'attached-link']);
   const selected=await runtime.methods.search_project_knowledge({query:'ОбщийПоисковыйМаркер',rootIds:['attached-link']}) as any;
   expect(selected.chunks).toHaveLength(1);expect(selected.chunks[0]).toMatchObject({rootId:'attached-link',rootLabel:'link'});
   expect(selected.sourceScope).toEqual({mode:'selected',rootIds:['attached-link']});
   const primary=await runtime.methods.globalSearch({query:'ОбщийПоисковыйМаркер',rootIds:[null],sourceClasses:['docs']}) as any;
   expect(primary.results).toHaveLength(1);expect(primary.results[0].rootId).toBeNull();
   expect((await runtime.methods.globalSearch({query:'ОбщийПоисковыйМаркер'}) as any).results).toHaveLength(2);
   await runtime.methods.ingestRecords({records:[{id:'tracker:db',refType:'tracker',refId:'db',sourceClass:'trackers',text:'DBМаркер'}]});
   expect(await runtime.methods.filterTrackerIds({ids:['db'],rootIds:['attached-link']})).toEqual([]);
   expect(await runtime.methods.filterTrackerIds({ids:['db','not-indexed'],rootIds:[null]})).toEqual([{id:'db',rootId:null}]);
   await expect(runtime.methods.globalSearch({query:'ОбщийПоисковыйМаркер',rootIds:[]})).rejects.toThrow('MEMORY_SOURCE_SCOPE_INVALID');
   roots=[roots[0]];await runtime.methods.list_sources();
   await expect(runtime.methods.search_project_knowledge({query:'ОбщийПоисковыйМаркер',rootIds:['attached-link']})).rejects.toThrow('MEMORY_SOURCE_SCOPE_INVALID');
  }finally{await runtime.deactivate();rmSync(base,{recursive:true,force:true});}
 });
 it('acknowledges one background rebuild while its indexing is still running and preserves legacy completion',async()=>{
  const root=realpathSync.native(mkdtempSync(path.join(tmpdir(),'memory-background-rebuild-')));
  const runtime=await activate({services:{workspacePath:root,extensionPath:root,dataDir:path.join(root,'state'),log:vi.fn(),getApiKey:async()=>({key:null}),registerMcpTools:async()=>({registered:[]})}});
  let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);
  let index:ReturnType<typeof vi.spyOn>|undefined;
  try{
   await vi.waitFor(async()=>expect((await runtime.methods.status() as any).indexing).toBe(false));
   index=vi.spyOn(MemoryEngine.prototype,'indexAll').mockImplementation(async()=>{await gate;return{indexed:0,files:0};});
   const ack=await runtime.methods.rebuild({background:true});expect(ack).toMatchObject({ok:true,queued:true,operationId:expect.any(Number)});
   expect(await runtime.methods.rebuild({background:true})).toEqual(ack);
   expect((await runtime.methods.status() as any).indexing).toBe(true);
   const legacy=runtime.methods.rebuild();release();await expect(legacy).resolves.toMatchObject({ok:true,indexed:0,files:0});
   expect(index).toHaveBeenCalledOnce();
  }finally{release();index?.mockRestore();await runtime.deactivate();rmSync(root,{recursive:true,force:true});}
 });
 it('reads confirmed rules without waiting for unrelated source-root filesystem checks',async()=>{
  const root=realpathSync.native(mkdtempSync(path.join(tmpdir(),'memory-fast-rule-read-')));
  let hold=false,release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);
  const runtime=await activate({services:{workspacePath:root,extensionPath:root,dataDir:path.join(root,'state'),log:vi.fn(),getApiKey:async()=>({key:null}),registerMcpTools:async()=>({registered:[]}),memorySourceRoots:async()=>{if(hold)await gate;return[{id:null,path:root,label:'main',available:true,treePaths:[root]}];}}});
  try {
   hold=true;
   const result=await Promise.race([runtime.methods.get_sources().then(()=> 'rules'),new Promise<string>(resolve=>setTimeout(()=>resolve('blocked'),100))]);
   expect(result).toBe('rules');
  } finally {hold=false;release();await runtime.deactivate();rmSync(root,{recursive:true,force:true});}
 });
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
   await vi.waitFor(async()=>expect((await runtime.methods.status() as any).bySourceClass.custom).toBeGreaterThan(0));
   expect((await runtime.methods.get_sources()).include).toEqual(['MAP.md']);
   await Promise.all([runtime.methods.set_sources({include:[],exclude:[]}),runtime.methods.set_sources({include:['MAP.md'],exclude:[]})]);
   expect((await runtime.methods.get_sources()).include).toEqual(['MAP.md']);
   await vi.waitFor(async()=>expect((await runtime.methods.status() as any).bySourceClass.custom).toBeGreaterThan(0));
   await runtime.methods.set_sources({include:[],exclude:[]});
   expect((await runtime.methods.get_sources()).include).toEqual([]);
   await vi.waitFor(async()=>expect((await runtime.methods.status() as any).bySourceClass.custom ?? 0).toBe(0));
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
   await vi.waitFor(async()=>expect((await runtime.methods.search_project_knowledge({query:'ПодключенныйКореньМаркер',k:8}) as any).chunks).toHaveLength(1));
   const found=await runtime.methods.search_project_knowledge({query:'ПодключенныйКореньМаркер',k:8}) as any;
   const primaryStatus=await runtime.methods.status({rootId:null}) as any;
   const linkedStatus=await runtime.methods.status({rootId:'attached-link'}) as any;
   const allStatus=await runtime.methods.status() as any;
   expect(primaryStatus.sourceFiles).toBe(1);expect(linkedStatus.sourceFiles).toBe(1);
   expect(allStatus.chunks).toBe(primaryStatus.chunks+linkedStatus.chunks);
   expect(primaryStatus.indexSizeBytes).toBeUndefined();expect(allStatus.indexSizeBytes).toBeGreaterThan(0);
   await expect(runtime.methods.status({rootId:'unknown'})).rejects.toThrow(/Unknown/);
   expect(found.chunks).toHaveLength(1);expect(found.chunks[0]).toMatchObject({sourcePath:'@attached-link/docs/a.md',refId:path.join(link,'docs/a.md'),rootLabel:'link',relativePath:'docs/a.md'});
   expect((await runtime.methods.search_project_knowledge({query:'АрхивПодключеннойПапкиМаркер'}) as any).chunks).toEqual([]);
   await runtime.methods.set_sources({rootId:'attached-link',include:['archive/**'],exclude:[]});
   expect((await runtime.methods.get_sources()).include).toEqual([]);
   expect(JSON.stringify(await runtime.methods.read_doc({path:'@attached-link/archive/a.md'}))).toContain('АрхивПодключеннойПапкиМаркер');
   await vi.waitFor(async()=>expect(JSON.stringify(await runtime.methods.expand({sourcePath:'@attached-link/archive/a.md'}))).toContain('АрхивПодключеннойПапкиМаркер'));
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


describe('file-tree Memory rule bridge',()=>{
 it('writes tree actions into editable includes/excludes and manual edits reconcile search in the background',async()=>{
  const root=mkdtempSync(path.join(tmpdir(),'memory-tree-rules-'));
  mkdirSync(path.join(root,'docs'));writeFileSync(path.join(root,'docs/a.md'),'# A\nТочечныйФайлМаркер');writeFileSync(path.join(root,'docs/b.md'),'# B\nСоседнийФайлМаркер');
  const runtime=await activate({services:{workspacePath:root,extensionPath:root,dataDir:path.join(root,'state'),log:vi.fn(),getApiKey:async()=>({key:null}),registerMcpTools:async()=>({registered:[]})}});
  try{
   await vi.waitFor(async()=>expect(await runtime.methods.status()).toMatchObject({ready:true,indexing:false}));
   await runtime.methods.set_path_override({path:path.join(root,'docs'),mode:'exclude'});
   await vi.waitFor(async()=>expect((await runtime.methods.search_project_knowledge({query:'ТочечныйФайлМаркер'})).chunks).toEqual([]));
   await runtime.methods.set_path_override({path:path.join(root,'docs/a.md'),mode:'include'});
   await vi.waitFor(async()=>expect((await runtime.methods.search_project_knowledge({query:'ТочечныйФайлМаркер'})).chunks).toHaveLength(1));
   expect((await runtime.methods.search_project_knowledge({query:'СоседнийФайлМаркер'})).chunks).toEqual([]);
   const tree=await runtime.methods.get_tree_index_state();
   if(!('files' in tree))throw Error('Expected the complete initial tree snapshot');
   expect(tree.files).toContain(path.join(root,'docs/a.md'));expect(tree.files).not.toContain(path.join(root,'docs/b.md'));
   expect(tree.directories).toContain(path.join(root,'docs'));
   expect(await runtime.methods.get_tree_index_state({revision:tree.revision})).toMatchObject({unchanged:true,revision:tree.revision});
   expect(await runtime.methods.get_sources()).toMatchObject({version:1,include:['docs/a.md'],exclude:['docs'],revision:expect.any(String)});
   await runtime.methods.set_sources({version:1,include:[],exclude:['docs']});
   await vi.waitFor(async()=>expect((await runtime.methods.search_project_knowledge({query:'ТочечныйФайлМаркер'})).chunks).toEqual([]));
   await expect(runtime.methods.set_path_override({path:tmpdir(),mode:'include'})).rejects.toThrow(/outside/);
  }finally{await runtime.deactivate();rmSync(root,{recursive:true,force:true});}
 });
});

describe('tree rules through a canonical workspace alias',()=>{
 it('keeps a junction/Windows short-path spelling inside its real workspace and colors both tree paths',async()=>{
  const fixture=mkdtempSync(path.join(tmpdir(),'memory-tree-alias-')),real=path.join(fixture,'real'),alias=path.join(fixture,'alias');
  mkdirSync(path.join(real,'docs'),{recursive:true});writeFileSync(path.join(real,'docs/a.md'),'# Alias\nAliasTreeMarker');symlinkSync(real,alias,'junction');
  const runtime=await activate({services:{workspacePath:alias,extensionPath:real,dataDir:path.join(fixture,'state'),log:vi.fn(),getApiKey:async()=>({key:null}),registerMcpTools:async()=>({registered:[]})}});
  try{
   await vi.waitFor(async()=>expect(await runtime.methods.status()).toMatchObject({ready:true,indexing:false}));
   await runtime.methods.set_path_override({path:path.join(alias,'docs'),mode:'exclude'});
   await vi.waitFor(async()=>expect((await runtime.methods.search_project_knowledge({query:'AliasTreeMarker'})).chunks).toEqual([]));
   await runtime.methods.set_path_override({path:path.join(alias,'docs/a.md'),mode:'include'});
   await vi.waitFor(async()=>expect((await runtime.methods.search_project_knowledge({query:'AliasTreeMarker'})).chunks).toHaveLength(1));
   const state=await runtime.methods.get_tree_index_state();if(!('files' in state))throw Error('Expected initial state');
   expect(state.files).toContain(path.join(alias,'docs/a.md'));expect(state.files).toContain(realpathSync.native(path.join(real,'docs/a.md')));
   await expect(runtime.methods.set_path_override({path:tmpdir(),mode:'include'})).rejects.toThrow(/outside/);
  }finally{await runtime.deactivate();rmSync(fixture,{recursive:true,force:true});}
 });
});


describe('durable source settings',()=>{
 it('does not publish a rule whose disk write failed',async()=>{
  const root=mkdtempSync(path.join(tmpdir(),'memory-failed-source-save-')),dataDir=path.join(root,'data');
  mkdirSync(path.join(root,'docs'));writeFileSync(path.join(root,'extra.md'),'# Extra\nARTIFICIAL_ONLY');
  const runtime=await activate({services:{workspacePath:root,extensionPath:root,dataDir,log:vi.fn(),getApiKey:async()=>({key:null}),registerMcpTools:async()=>({registered:[]})}});
  try{
   await vi.waitFor(async()=>expect((await runtime.methods.status() as any).indexing).toBe(false));
   mkdirSync(path.join(dataDir,'sources.json.tmp'));
   await expect(runtime.methods.set_path_override({path:path.join(root,'extra.md'),mode:'include'})).rejects.toThrow();
   expect((await runtime.methods.get_sources()).include).toEqual([]);
  }finally{await runtime.deactivate();rmSync(root,{recursive:true,force:true});}
 });
});


describe('asynchronous rule reconciliation',()=>{
 it('acknowledges durable rules and roots before a gated file, then rejects an outdated editor revision',async()=>{
  const root=mkdtempSync(path.join(tmpdir(),'memory-save-ack-')),extra=path.join(root,'extra.md');
  writeFileSync(extra,'# Extra\nARTIFICIAL_ASYNC_MARKER');
  const runtime=await activate({services:{workspacePath:root,extensionPath:root,dataDir:path.join(root,'state'),log:vi.fn(),getApiKey:async()=>({key:null}),registerMcpTools:async()=>({registered:[]})}});
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  try{
   await vi.waitFor(async()=>expect((await runtime.methods.status() as any).indexing).toBe(false));
   const before=await runtime.methods.get_sources();let entered=false;
   const original=Indexer.prototype.indexFile;
   const spy=vi.spyOn(Indexer.prototype,'indexFile').mockImplementation(async function(this:Indexer,...args:Parameters<Indexer['indexFile']>){entered=true;await gate;return original.apply(this,args);});
   try{
    const ack=await Promise.race([runtime.methods.set_path_override({path:extra,mode:'include'}),new Promise<never>((_,reject)=>setTimeout(()=>reject(Error('Save waited for embeddings')),1000))]);
    expect(ack).toMatchObject({rules:{include:['extra.md']},revision:expect.any(String),indexingQueued:true});
    expect(treePolicyIncludes(ack.treePolicy,extra)).toBe(true);
    expect((await runtime.methods.get_sources()).include).toEqual(['extra.md']);
    expect(await runtime.methods.get_source_roots()).toHaveLength(1);
    await vi.waitFor(()=>expect(entered).toBe(true));
    expect(await runtime.methods.status()).toMatchObject({indexing:true,operation:{kind:'rules',totalFiles:1,completedFiles:0}});
    await expect(runtime.methods.set_sources({include:[],exclude:[],expectedRevision:before.revision})).rejects.toThrow(/changed elsewhere/);
    // A later exclusion wins even when a provider response for the inclusion arrives afterwards.
    await runtime.methods.set_path_override({path:extra,mode:'exclude'});
    expect((await runtime.methods.get_sources()).exclude).toEqual(['extra.md']);
    release();
    await vi.waitFor(async()=>expect((await runtime.methods.status() as any).indexing).toBe(false));
    expect((await runtime.methods.search_project_knowledge({query:'ARTIFICIAL_ASYNC_MARKER'})).chunks).toEqual([]);
   }finally{release();spy.mockRestore();}
  }finally{await runtime.deactivate();rmSync(root,{recursive:true,force:true});}
 });
 it('does not retry a failed rule job when source roots are polled',async()=>{
  // The real host broker canonicalizes Windows short paths and retains tree aliases.
  const root=mkdtempSync(path.join(tmpdir(),'memory-no-poll-retry-'));writeFileSync(path.join(root,'extra.md'),'# Extra\nARTIFICIAL_ONLY');
  const runtime=await activate({services:{workspacePath:root,extensionPath:root,dataDir:path.join(root,'state'),log:vi.fn(),getApiKey:async()=>({key:null}),registerMcpTools:async()=>({registered:[]}),memorySourceRoots:async()=>[{id:null,path:realpathSync.native(root),label:'main',available:true,treePaths:[root]}]}});
  try{
   await vi.waitFor(async()=>expect((await runtime.methods.status() as any).indexing).toBe(false));
   const spy=vi.spyOn(Indexer.prototype,'indexFile').mockRejectedValue(Object.assign(Error('artificial quota'),{status:429}));
   try{
    await runtime.methods.set_path_override({path:path.join(root,'extra.md'),mode:'include'});
    await vi.waitFor(async()=>expect(await runtime.methods.status()).toMatchObject({operation:{state:'failed',error:{category:'quota'}}}));
    const count=spy.mock.calls.length;
    await new Promise(resolve=>setTimeout(resolve,2200));
    await runtime.methods.get_source_roots();await runtime.methods.status();
    expect(spy).toHaveBeenCalledTimes(count);
   }finally{spy.mockRestore();}
  }finally{await runtime.deactivate();rmSync(root,{recursive:true,force:true});}
 });
});


describe('policy membership before background directory work',()=>{
 it('colors all visible children from the saved directory rule before indexing any of them',async()=>{
  const root=mkdtempSync(path.join(tmpdir(),'memory-visible-rules-')),dir=path.join(root,'extra');mkdirSync(dir);const files=['a.md','b.txt'].map(name=>path.join(dir,name));for(const file of files)writeFileSync(file,'ARTIFICIAL_VISIBLE');
  const runtime=await activate({services:{workspacePath:root,extensionPath:root,dataDir:path.join(root,'state'),log:vi.fn(),getApiKey:async()=>({key:null}),registerMcpTools:async()=>({registered:[]})}});
  let release!:()=>void;const gate=new Promise<void>(r=>release=r);
  try{
   await vi.waitFor(async()=>expect((await runtime.methods.status() as any).indexing).toBe(false));
   const original=Indexer.prototype.indexFile,spy=vi.spyOn(Indexer.prototype,'indexFile').mockImplementation(async function(this:Indexer,...args:Parameters<Indexer['indexFile']>){await gate;return original.apply(this,args);});
   try{
    const receipt=await runtime.methods.set_path_override({path:dir,mode:'include',visiblePaths:files});for(const file of files)expect(treePolicyIncludes(receipt.treePolicy,file)).toBe(true);
    expect((await runtime.methods.get_sources()).include).toEqual(['extra']);
    expect(await runtime.methods.status()).toMatchObject({available:{chunks:0}});
    release();await vi.waitFor(async()=>expect((await runtime.methods.status() as any).indexing).toBe(false));
   }finally{release();spy.mockRestore();}
  }finally{await runtime.deactivate();rmSync(root,{recursive:true,force:true});}
 });
 it('never retries a failed manually entered include from discovery polling',async()=>{
  const root=mkdtempSync(path.join(tmpdir(),'memory-manual-no-retry-'));writeFileSync(path.join(root,'extra.md'),'ARTIFICIAL_ONLY');
  const runtime=await activate({services:{workspacePath:root,extensionPath:root,dataDir:path.join(root,'state'),log:vi.fn(),getApiKey:async()=>({key:null}),registerMcpTools:async()=>({registered:[]})}});
  try{
   await vi.waitFor(async()=>expect((await runtime.methods.status() as any).indexing).toBe(false));
   const spy=vi.spyOn(Indexer.prototype,'indexFile').mockRejectedValue(Object.assign(Error('artificial quota'),{status:429}));
   try{await runtime.methods.set_sources({include:['extra.md'],exclude:[]});await vi.waitFor(()=>expect(spy).toHaveBeenCalledTimes(1));await new Promise(resolve=>setTimeout(resolve,3600));expect(spy).toHaveBeenCalledTimes(1);}finally{spy.mockRestore();}
  }finally{await runtime.deactivate();rmSync(root,{recursive:true,force:true});}
 });
});


describe('fast durable rule writer without index preparation',()=>{
 it('acknowledges both textarea and path writes before touching the indexer or asking for a tree snapshot',async()=>{
  const root=realpathSync.native(mkdtempSync(path.join(tmpdir(),'memory-lightweight-save-')));writeFileSync(path.join(root,'extra.md'),'# Artificial\nFAST_SAVE_PROBE');
  const runtime=await activate({services:{workspacePath:root,extensionPath:root,dataDir:path.join(root,'state'),log:vi.fn(),getApiKey:async()=>({key:null}),registerMcpTools:async()=>({registered:[]})}});
  try{
   await vi.waitFor(async()=>expect((await runtime.methods.status() as any).indexing).toBe(false));
   const update=vi.spyOn(MemoryEngine.prototype,'updateSources').mockImplementation(()=>{throw Error('ARTIFICIAL_INDEXER_UNAVAILABLE');});
   const tree=vi.spyOn(runtime.methods,'get_tree_index_state').mockImplementation(()=>new Promise(()=>{}));
   try{
    const form=await runtime.methods.set_sources({include:['extra.md'],exclude:[]});expect(form.rules.include).toEqual(['extra.md']);expect(update).not.toHaveBeenCalled();
    const pathSave=await Promise.race([runtime.methods.set_path_override({path:path.join(root,'extra.md'),mode:'exclude'}),new Promise<never>((_,reject)=>setTimeout(()=>reject(Error('Save waited for tree/indexer')),800))]);
    expect(pathSave.rules.exclude).toEqual(['extra.md']);expect(tree).not.toHaveBeenCalled();expect(update).not.toHaveBeenCalled();
    expect((await runtime.methods.get_sources()).exclude).toEqual(['extra.md']);
    await vi.waitFor(()=>expect(update).toHaveBeenCalledTimes(1));
    expect(await runtime.methods.status()).toMatchObject({sourceUpdate:{pending:false,error:{category:'other'}}});
   }finally{tree.mockRestore();update.mockRestore();}
  }finally{await runtime.deactivate();rmSync(root,{recursive:true,force:true});}
 });
 it('applies rapid menu operations in order and lets a following field save use the acknowledged revision',async()=>{
  const root=realpathSync.native(mkdtempSync(path.join(tmpdir(),'memory-ordered-save-')));writeFileSync(path.join(root,'extra.md'),'# Artificial\nORDER_SAVE_PROBE');
  const runtime=await activate({services:{workspacePath:root,extensionPath:root,dataDir:path.join(root,'state'),log:vi.fn(),getApiKey:async()=>({key:null}),registerMcpTools:async()=>({registered:[]})}});
  try{await vi.waitFor(async()=>expect((await runtime.methods.status() as any).indexing).toBe(false));
   const updates=await Promise.all(['include','exclude','include'].map(mode=>runtime.methods.set_path_override({path:path.join(root,'extra.md'),mode:mode as 'include'|'exclude'})));
   expect(updates.map(r=>r.rules.include.includes('extra.md'))).toEqual([true,false,true]);
   expect(await runtime.methods.get_sources()).toMatchObject({include:['extra.md'],exclude:[],revision:updates[2].revision});
   const saved=await runtime.methods.set_sources({include:[],exclude:['extra.md'],expectedRevision:updates[2].revision});expect(saved.rules).toMatchObject({include:[],exclude:['extra.md']});
  }finally{await runtime.deactivate();rmSync(root,{recursive:true,force:true});}
 });
});


describe('lightweight icon polling',()=>{
 it('reads the source policy and cached diagnostics without preparing an index or a full tree',async()=>{
  const root=realpathSync.native(mkdtempSync(path.join(tmpdir(),'memory-policy-poll-')));
  const runtime=await activate({services:{workspacePath:root,extensionPath:root,dataDir:path.join(root,'state'),log:vi.fn(),getApiKey:async()=>({key:null}),registerMcpTools:async()=>({registered:[]})}});
  try{await vi.waitFor(async()=>expect((await runtime.methods.status() as any).indexing).toBe(false));
   const status=vi.spyOn(MemoryEngine.prototype,'status').mockImplementation(()=>{throw Error('Full status must not run');});
   const tree=vi.spyOn(MemoryEngine.prototype,'ruleFilePaths').mockImplementation(()=>{throw Error('Full tree must not run');});
   try{const state=await runtime.methods.get_tree_index_state({policyOnly:true});expect(state).toHaveProperty('treePolicy');if(!('treePolicy' in state)||!state.treePolicy)throw Error('Policy missing');expect(treePolicyIncludes(state.treePolicy,path.join(root,'docs/a.md'))).toBe(true);expect(status).not.toHaveBeenCalled();expect(tree).not.toHaveBeenCalled();}finally{status.mockRestore();tree.mockRestore();}
  }finally{await runtime.deactivate();rmSync(root,{recursive:true,force:true});}
 });
});
