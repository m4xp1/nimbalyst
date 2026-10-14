// @vitest-environment node
import { describe,it,expect,vi } from 'vitest';import { mkdtempSync,mkdirSync,writeFileSync,rmSync } from 'node:fs';import { tmpdir } from 'node:os';import path from 'node:path';
import { activate } from '../backend';
describe('source settings backend bridge',()=>{
 it('registers panel-only methods and survives source apply/rebuild without losing tool registration',async()=>{
  const root=mkdtempSync(path.join(tmpdir(),'memory-backend-')),dataDir=path.join(root,'data');mkdirSync(path.join(root,'docs'));writeFileSync(path.join(root,'docs/a.md'),'# Build\nСборка установщика');writeFileSync(path.join(root,'MAP.md'),'# Map\nУникальная карта');
  const register=vi.fn(async(tools:any[])=>({registered:tools.map(t=>t.name)}));
  const runtime=await activate({services:{workspacePath:root,extensionPath:root,dataDir,log:vi.fn(),getApiKey:async()=>({key:null}),registerMcpTools:register}});
  try{
   const tools=register.mock.calls[0][0];for(const name of ['get_sources','set_sources'])expect(tools.find(t=>t.name===name)?.panelOnly).toBe(true);expect(tools.find(t=>t.name==='status')?.panelOnly).toBeUndefined();
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
