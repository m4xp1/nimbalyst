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
});
