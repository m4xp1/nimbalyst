// @vitest-environment node
import { describe,it,expect,afterEach,vi } from 'vitest';
import { mkdtempSync,mkdirSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';import path from 'node:path';
import { MemoryEngine } from '../engine.js';
import { Indexer } from '../indexer/indexer.js';import { FakeEmbedder } from './fakeEmbedder.js';
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
  expect(JSON.stringify(engine.status().fileIndex)).not.toContain('sk-secret');expect(engine.status().watching).toBe(true);
  for(const [message,category] of [['429 rate_limit','rate-limit'],['fetch failed','network'],['400 input too large','input'],['unexpected SECRET','other']])expect(safeIndexError(new Error(message)).category).toBe(category);
 });
});


describe('source failure recovery', () => {
 it('continues after an invalid source and quarantines old results across restart', async () => {
  const {root,embedder,engine}=setup();
  writeFileSync(path.join(root,'docs/b.md'),'# Old\nOLDPRIVATEMARKER');
  await engine.indexAll();
  writeFileSync(path.join(root,'docs/a.md'),'# A\nEARLYPROBE624');
  writeFileSync(path.join(root,'docs/b.md'),'# Bad\nREJECTPROBE624');
  writeFileSync(path.join(root,'docs/c.md'),'# C\nLATEPROBE624');
  const original=embedder.embed.bind(embedder);
  const spy=vi.spyOn(embedder,'embed').mockImplementation(async texts=>{
   if(texts.some(t=>t.includes('REJECTPROBE624')))throw Object.assign(new Error('maximum input length exceeded PRIVATE_RESPONSE'),{code:'EMBEDDING_INPUT_TOO_LARGE'});
   return original(texts);
  });
  await expect(engine.indexAll()).resolves.toMatchObject({files:3});
  expect(engine.status().fileIndex).toMatchObject({state:'partial',completedFiles:2,failedFiles:1,remainingFiles:0});
  expect(engine.status().watching).toBe(true);
  expect((await engine.search('LATEPROBE624',20)).some(h=>h.text.includes('LATEPROBE624'))).toBe(true);
  expect((await engine.search('OLDPRIVATEMARKER',20)).some(h=>h.text.includes('OLDPRIVATEMARKER'))).toBe(false);
  expect(engine.expand('docs/b.md',['Old'])).toBeNull();
  expect(JSON.stringify(engine.status())).not.toContain('PRIVATE_RESPONSE');
  spy.mockRestore();
  await engine.close();engines.splice(engines.indexOf(engine),1);
  const reopened=MemoryEngine.create({root,dbPath:path.join(root,'index.db'),factsDir:'facts',sources:[{sourceClass:'docs',include:['docs/**/*.md']}]},embedder);engines.push(reopened);
  expect((await reopened.search('OLDPRIVATEMARKER',20)).some(h=>h.text.includes('OLDPRIVATEMARKER'))).toBe(false);
  reopened.startWatching();
  writeFileSync(path.join(root,'docs/b.md'),'# Fresh\nRECOVEREDPROBE624');
  await vi.waitFor(async()=>expect((await reopened.search('RECOVEREDPROBE624',20)).some(h=>h.text.includes('RECOVEREDPROBE624'))).toBe(true),{timeout:6000});
  expect(reopened.status().fileIndex?.failedFiles).toBe(0);
 });
});


describe('scoped diagnostics and provider failures',()=>{
 it('separates attached-root counts and leaves remaining files on a global error',async()=>{
  const {root,embedder,engine}=setup();
  const attached=mkdtempSync(path.join(tmpdir(),'memory-status-attached-'));roots.push(attached);
  writeFileSync(path.join(root,'docs/a.md'),'# Main\nPRIMARYPROBE624');
  writeFileSync(path.join(root,'docs/b.md'),'# Main2\nSECONDPROBE624');
  writeFileSync(path.join(attached,'a.md'),'# Attached\nROOTPROBE624');
  await engine.updateSources([{sourceClass:'docs',include:['docs/**/*.md']},{sourceClass:'docs',include:['*.md'],root:{id:'link',path:attached}}],[]);
  expect(engine.status(null)).toMatchObject({sourceFiles:2,fileIndex:{discoveredFiles:2,completedFiles:2,failedFiles:0}});
  expect(engine.status('link')).toMatchObject({sourceFiles:1,fileIndex:{discoveredFiles:1,completedFiles:1,failedFiles:0}});
  expect(engine.status().chunks).toBe(engine.status(null).chunks+engine.status('link').chunks);
  writeFileSync(path.join(root,'docs/a.md'),'# Main\nCHANGEDPROBE624');
  writeFileSync(path.join(root,'docs/b.md'),'# Main2\nCHANGEDSECOND624');
  const spy=vi.spyOn(embedder,'embed').mockRejectedValue(Object.assign(new Error('provider refused PRIVATE_BODY'),{status:400}));
  await expect(engine.indexAll()).rejects.toThrow();
  expect(spy).toHaveBeenCalledTimes(1);
  expect(engine.status().fileIndex).toMatchObject({failedFiles:1,remainingFiles:2,error:{category:'other'}});
  expect(engine.status().watching).toBe(true);
 });
});


describe('responsive source policy updates',()=>{
 it('publishes a policy before embeddings and touches only its target',async()=>{
  const {root,embedder,engine}=setup();
  writeFileSync(path.join(root,'docs/a.md'),'# A\nUNCHANGED_TARGET_A');
  writeFileSync(path.join(root,'extra.md'),'# Extra\nNEW_TARGET_EXTRA');
  await engine.indexAll();
  let release!:()=>void,entered!:()=>void;const hold=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);
  const original=embedder.embed.bind(embedder);const calls=vi.spyOn(embedder,'embed').mockImplementation(async texts=>{if(texts.some(t=>t.includes('NEW_TARGET_EXTRA'))){entered();await hold;}return original(texts);});
  const files=vi.spyOn(Indexer.prototype,'indexFile');
  const update=(engine.updateSources as any)([{sourceClass:'docs',include:['docs/**/*.md']},{sourceClass:'custom',include:['extra.md']}],[],{paths:[path.join(root,'extra.md')],incremental:true});
  try {
   await started;
   expect(engine.ruleFilePaths()).toContain(path.join(root,'extra.md'));
   expect((engine.status() as any).operation).toMatchObject({state:'running',totalFiles:1,completedFiles:0});
   expect(files.mock.calls.map(([file])=>file)).toEqual(['extra.md']);
   expect(calls.mock.calls.flat(2).every(t=>!t.includes('UNCHANGED_TARGET_A'))).toBe(true);
  }finally{release();await update;files.mockRestore();calls.mockRestore();}
 });
 it('separates available chunks from stored page rows and quarantined sources',async()=>{
  const {root,embedder,engine}=setup();writeFileSync(path.join(root,'docs/a.md'),'# First\nFIRST_AVAILABLE\n## Second\nSECOND_AVAILABLE');await engine.indexAll();
  expect((engine.status() as any).available).toMatchObject({chunks:2,sourceFiles:1});
  writeFileSync(path.join(root,'docs/a.md'),'# Changed\nINVALID_SOURCE');
  const spy=vi.spyOn(embedder,'embed').mockRejectedValue(Object.assign(new Error('input rejected'),{code:'EMBEDDING_INPUT_TOO_LARGE'}));
  try{await engine.indexAll();expect((engine.status() as any).available).toMatchObject({chunks:0,sourceFiles:0});expect(engine.status().chunks).toBeGreaterThan(0);}finally{spy.mockRestore();}
 });
});
