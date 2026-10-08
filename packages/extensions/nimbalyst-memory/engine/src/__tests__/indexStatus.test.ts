// @vitest-environment node
import { describe,it,expect,afterEach,vi } from 'vitest';
import { mkdtempSync,mkdirSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';import path from 'node:path';
import { MemoryEngine } from '../engine.js';import { FakeEmbedder } from './fakeEmbedder.js';
import { safeIndexError } from '../indexStatus.js';import { buildPublicEngineStatus } from '../searchResponse.js';
const roots:string[]=[],engines:MemoryEngine[]=[];
function setup(){const root=mkdtempSync(path.join(tmpdir(),'memory-status-'));roots.push(root);mkdirSync(path.join(root,'docs'));const embedder=new FakeEmbedder();const engine=MemoryEngine.create({root,dbPath:path.join(root,'index.db'),factsDir:'facts',sources:[{sourceClass:'docs',include:['docs/**/*.md']}]},embedder);engines.push(engine);return{root,embedder,engine};}
afterEach(async()=>{for(const e of engines.splice(0))await e.close();for(const r of roots.splice(0))rmSync(r,{recursive:true,force:true});});
describe('truthful index status',()=>{
 it('uses unknown scan counts until enumeration and status reads never embed',async()=>{
  const {root,embedder,engine}=setup(),spy=vi.spyOn(embedder,'embed');
  expect(engine.status().fileIndex?.discoveredFiles).toBeNull();expect(engine.status().watching).toBe(false);
  writeFileSync(path.join(root,'docs/a.md'),'# First\nquartzorchid');await engine.indexAll();
  expect(engine.status().fileIndex).toMatchObject({state:'ready',discoveredFiles:1,completedFiles:1,failedFiles:0});
  spy.mockClear();for(let i=0;i<3;i++)engine.status();await engine.indexSizeBytes();expect(spy).not.toHaveBeenCalled();
  await engine.indexAll();expect(spy).not.toHaveBeenCalled();engine.startWatching();expect(engine.status().watching).toBe(true);
 });
 it('unchanged rebuilds do not write chunks, embed or inflate size after reopen',async()=>{
  const {root,embedder,engine}=setup();writeFileSync(path.join(root,'docs/a.md'),'# First\nquartzorchid');await engine.indexAll();
  const before=(engine as any).store.loadAll(),size=await engine.indexSizeBytes();
  const embed=vi.spyOn(embedder,'embed'),upsert=vi.spyOn((engine as any).store,'upsertChunks');
  for(let i=0;i<12;i++)await engine.indexAll();
  expect(embed).not.toHaveBeenCalled();expect(upsert).not.toHaveBeenCalled();
  expect((engine as any).store.loadAll()).toEqual(before);expect(await engine.indexSizeBytes()).toBe(size);
  await engine.close();engines.splice(engines.indexOf(engine),1);
  const reopened=MemoryEngine.create({root,dbPath:path.join(root,'index.db'),factsDir:'facts',sources:[]},embedder);engines.push(reopened);
  expect(await reopened.indexSizeBytes()).toBe(size);expect((reopened as any).store.loadAll()).toEqual(before);
 });
 it('reports partial failure even when saved vectors have 100 percent coverage',async()=>{
  const {root,embedder,engine}=setup();writeFileSync(path.join(root,'docs/a.md'),'# First\nquartzorchid');await engine.indexAll();
  writeFileSync(path.join(root,'docs/b.md'),'# Second\nmarigold');vi.spyOn(embedder,'embed').mockRejectedValue(new Error('OpenAI failed (429): insufficient_quota SECRET RESPONSE'));
  await expect(engine.indexAll()).rejects.toThrow();const status=engine.status();
  expect(status.chunks).toBe(status.denseChunks);expect(status.fileIndex).toMatchObject({state:'partial',discoveredFiles:2,failedFiles:1,error:{category:'quota'}});
  expect(JSON.stringify(buildPublicEngineStatus(status))).not.toContain('SECRET RESPONSE');expect(engine.expand('docs/a.md',['First'])?.text).toContain('quartzorchid');
 });
 it('reports failure with no saved text and classifies errors without leaking responses',async()=>{
  const {root,embedder,engine}=setup();writeFileSync(path.join(root,'docs/a.md'),'# First\nquartzorchid');vi.spyOn(embedder,'embed').mockRejectedValue(new Error('401 sk-secret document-private'));
  await expect(engine.indexAll()).rejects.toThrow();expect(engine.status().fileIndex?.state).toBe('failed');expect(engine.status().fileIndex?.error?.category).toBe('authentication');
  expect(JSON.stringify(engine.status().fileIndex)).not.toContain('sk-secret');expect(engine.status().watching).toBe(false);
  for(const [message,category] of [['429 rate_limit','rate-limit'],['fetch failed','network'],['400 input too large','input'],['unexpected SECRET','other']])expect(safeIndexError(new Error(message)).category).toBe(category);
 });
});
