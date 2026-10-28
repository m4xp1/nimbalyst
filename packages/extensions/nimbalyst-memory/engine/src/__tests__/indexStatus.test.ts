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
 it('reuses Coverage aggregates until searchable content changes',async()=>{
  const {root,engine}=setup();writeFileSync(path.join(root,'docs/a.md'),'# First\ncacheprobe');await engine.indexAll();
  const summaries=vi.spyOn((engine as any).store,'sourceSummaries');
  for(let i=0;i<12;i++){expect(engine.status().available?.indexedFiles).toBe(1);expect(engine.status(null).available?.indexedFiles).toBe(1);}
  expect(summaries).toHaveBeenCalledTimes(1);
  writeFileSync(path.join(root,'docs/b.md'),'# Second\ncacheprobe');await engine.indexAll();
  expect(engine.status().available?.indexedFiles).toBe(2);expect(summaries).toHaveBeenCalledTimes(2);
 });
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
   expect(calls.mock.calls.flatMap(([texts])=>texts).every(t=>!t.includes('UNCHANGED_TARGET_A'))).toBe(true);
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


describe('watcher cancellation and policy changes',()=>{
 it('reconciles the interrupted changed file together with a new rule target',async()=>{
  const {root,embedder,engine}=setup();writeFileSync(path.join(root,'docs/a.md'),'# A\nORIGINAL_WATCH_VALUE');writeFileSync(path.join(root,'extra.md'),'# Extra\nEXTRA_RULE_VALUE');await engine.indexAll();
  let release!:()=>void,enter!:()=>void;const gate=new Promise<void>(r=>release=r),entered=new Promise<void>(r=>enter=r);const original=embedder.embed.bind(embedder);let held=false;
  const spy=vi.spyOn(embedder,'embed').mockImplementation(async texts=>{if(!held&&texts.some(text=>text.includes('CHANGED_WATCH_VALUE'))){held=true;enter();await gate;}return original(texts);});
  writeFileSync(path.join(root,'docs/a.md'),'# A\nCHANGED_WATCH_VALUE');
  try{
   await Promise.race([entered,new Promise<never>((_,reject)=>setTimeout(()=>reject(Error('Watcher did not start')),4000))]);
   const update=engine.updateSources([{sourceClass:'docs',include:['docs/**/*.md']},{sourceClass:'custom',include:['extra.md']}],[],{paths:[path.join(root,'extra.md')],incremental:true});
   release();await update;
   expect((await engine.search('CHANGED_WATCH_VALUE',20)).some(hit=>hit.text.includes('CHANGED_WATCH_VALUE'))).toBe(true);
   expect((await engine.search('EXTRA_RULE_VALUE',20)).some(hit=>hit.text.includes('EXTRA_RULE_VALUE'))).toBe(true);
  }finally{release();spy.mockRestore();}
 });
});


describe('rule-job watcher handoff',()=>{
 it('does not acknowledge away an edit made while embeddings were in flight',async()=>{
  const {root,embedder,engine}=setup(),file=path.join(root,'extra.md');writeFileSync(file,'# Extra\nBEFORE_IN_FLIGHT');await engine.indexAll();
  let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>enter=r),gate=new Promise<void>(r=>release=r),original=embedder.embed.bind(embedder);let held=false;
  const spy=vi.spyOn(embedder,'embed').mockImplementation(async texts=>{if(!held&&texts.some(text=>text.includes('BEFORE_IN_FLIGHT'))){held=true;enter();await gate;}return original(texts);});
  const update=engine.updateSources([{sourceClass:'docs',include:['docs/**/*.md']},{sourceClass:'custom',include:['extra.md']}],[],{paths:[file],incremental:true});
  try{
   await entered;writeFileSync(file,'# Extra\nAFTER_IN_FLIGHT_CHANGED');await new Promise(resolve=>setTimeout(resolve,700));release();await update;
   await vi.waitFor(async()=>expect((await engine.search('AFTER_IN_FLIGHT_CHANGED',20)).some(hit=>hit.text.includes('AFTER_IN_FLIGHT_CHANGED'))).toBe(true),{timeout:4500});
  }finally{release();await update;spy.mockRestore();}
 });
});


describe('directory source-rule reconciliation',()=>{
 it('indexes only files of an included directory and preserves a narrower include during exclusion',async()=>{
  const {root,engine,embedder}=setup();mkdirSync(path.join(root,'research'));writeFileSync(path.join(root,'docs/a.md'),'# Base\nBASE_DIRECTORY_PROBE');writeFileSync(path.join(root,'research/a.md'),'# Extra\nEXTRA_DIRECTORY_PROBE');writeFileSync(path.join(root,'research/keep.md'),'# Keep\nKEEP_DIRECTORY_PROBE');
  await engine.indexAll();const base=[{sourceClass:'docs',include:['docs/**/*.md']}];
  await engine.updateSources([...base,{sourceClass:'custom',include:['research'],sourceRules:{include:['research'],exclude:[]}}],[],{paths:[path.join(root,'research')],incremental:true});
  expect(engine.status().operation).toMatchObject({state:'completed',totalFiles:2,completedFiles:2,failedFiles:0});expect(engine.status().fileIndex?.failures).toEqual([]);expect(engine.status().available?.indexedFiles).toBe(3);
  const spy=vi.spyOn(embedder,'embed');
  await engine.updateSources([...base,{sourceClass:'custom',include:['research/keep.md'],sourceRules:{include:['research/keep.md'],exclude:['research']}}],['research'],{paths:[path.join(root,'research')],incremental:true});
  expect(engine.status().operation).toMatchObject({state:'completed',totalFiles:2,failedFiles:0});expect(engine.expand('research/a.md',[])).toBeNull();expect(engine.expand('research/keep.md',[])?.text).toContain('KEEP_DIRECTORY_PROBE');expect(engine.status().available?.indexedFiles).toBe(2);expect(spy).not.toHaveBeenCalled();
 });
 it('clears persisted directory failures after restart without dropping real file failures or reembedding unchanged text',async()=>{
  const {root,engine,embedder}=setup();writeFileSync(path.join(root,'docs/a.md'),'# A\nA_DIRECTORY_PROBE');writeFileSync(path.join(root,'docs/b.md'),'# B\nB_DIRECTORY_PROBE');await engine.indexAll();
  const storage=(engine as any).store;storage.setIndexDiagnostics({...storage.getIndexDiagnostics(),failures:[{sourcePath:'docs',relativePath:'docs',rootId:null,error:{category:'other',action:'old directory'},updatedAt:1},{sourcePath:'docs/a.md',relativePath:'docs/a.md',rootId:null,error:{category:'access',action:'real file'},updatedAt:1}]});
  engines.splice(engines.indexOf(engine),1);await engine.close();
  const sources=[{sourceClass:'docs',include:['docs/**/*.md']}],reopened=MemoryEngine.create({root,dbPath:path.join(root,'index.db'),factsDir:'facts',sources},embedder);engines.push(reopened);const spy=vi.spyOn(embedder,'embed');
  await reopened.updateSources(sources,[],{paths:[path.join(root,'docs/b.md')],incremental:true});
  expect(reopened.status().fileIndex?.failures?.map(f=>f.sourcePath)).toEqual(['docs/a.md']);expect(reopened.expand('docs/b.md',[])?.text).toContain('B_DIRECTORY_PROBE');expect(reopened.status().chunks).toBe(2);expect(spy).not.toHaveBeenCalled();
 });
});


describe('eventual rule search publication',()=>{
 it('keeps prior search results while the source job is queued, then removes them without embedding',async()=>{
  const {root,engine,embedder}=setup();const file=path.join(root,'docs/a.md');writeFileSync(file,'# A\nEVENTUAL_EXCLUDE_PROBE');await engine.indexAll();
  let release!:()=>void;const gate=new Promise<void>(r=>release=r);const held=(engine as any).fileWork.run(()=>gate);
  const spy=vi.spyOn(embedder,'embed');
  const update=engine.updateSources([{sourceClass:'docs',include:['docs/**/*.md'],sourceRules:{include:[],exclude:['docs/a.md']}}],[],{paths:[file],incremental:true});
  try{expect(engine.expand('docs/a.md',[])?.text).toContain('EVENTUAL_EXCLUDE_PROBE');expect(engine.status().available?.indexedFiles).toBe(1);
   release();await held;await update;expect(engine.expand('docs/a.md',[])).toBeNull();expect(engine.status().available?.indexedFiles).toBe(0);expect(spy).not.toHaveBeenCalled();
  }finally{release();await update;spy.mockRestore();}
 });
});


describe('available entity counts',()=>{
 it('counts unique files, sessions and cards separately from chunks',async()=>{
  const {root,engine}=setup();writeFileSync(path.join(root,'docs/a.md'),'# A\nCOUNT_FILE_ONE\n## B\nCOUNT_FILE_TWO');await engine.indexAll();
  await engine.ingestRecords([{id:'session:one',refType:'session',refId:'one',sourceClass:'sessions',title:'Artificial session',text:'# A\nCOUNT_SESSION_ONE\n## B\nCOUNT_SESSION_TWO'},{id:'tracker:one',refType:'tracker',refId:'one',sourceClass:'trackers',title:'Artificial card',text:'COUNT_CARD_ONE'}]);
  expect(engine.status().available).toMatchObject({indexedFiles:1,sessions:1,trackers:1,sourceFiles:3});expect(engine.status().available!.chunks).toBeGreaterThan(3);
 });
});


describe('scoped observer failures',()=>{
 it('attributes discovery failures to their root and clears only a verified matching scope',async()=>{
  const {root,engine}=setup();const other=mkdtempSync(path.join(tmpdir(),'memory-status-other-'));roots.push(other);
  writeFileSync(path.join(root,'docs/a.md'),'# A\nSCOPED_PRIMARY');writeFileSync(path.join(other,'b.md'),'# B\nSCOPED_OTHER');
  await engine.updateSources([{sourceClass:'docs',include:['docs/**/*.md']},{sourceClass:'custom',include:['**/*.md'],root:{id:'other',path:other}}],[]);
  const watcher=(engine as any).watcher;
  watcher.onError(Object.assign(Error('private path should not cross status'),{code:'EACCES'}),undefined,{stage:'discovery',rootId:'other'});
  expect(engine.status(null).fileIndex?.state).toBe('ready');
  expect(engine.status('other').fileIndex).toMatchObject({state:'partial',issues:[{stage:'discovery',rootId:'other',code:'EACCES',state:'active'}]});
  watcher.onVerified?.({stage:'discovery',rootId:null});
  expect(engine.status().fileIndex?.state).toBe('partial');
  watcher.onVerified?.({stage:'discovery',rootId:'other'});
  expect(engine.status().fileIndex?.state).toBe('ready');
  expect(engine.status('other').fileIndex?.issues).toMatchObject([{state:'recovered'}]);
  expect(JSON.stringify(engine.status())).not.toContain('private path');
 });
 it('ignores old watcher errors after its generation is stopped',async()=>{
  const {root,engine}=setup();writeFileSync(path.join(root,'docs/a.md'),'# A\nGENERATION_PRIMARY');await engine.indexAll();
  const watcher=(engine as any).watcher;await watcher.stop();
  watcher.reportError?.(Object.assign(Error('late'),{code:'EACCES'}),{stage:'watch',rootId:null});
  expect(engine.status().fileIndex?.state).toBe('ready');
 });
});


describe('observer diagnostic persistence',()=>{
 it('preserves scoped errors across reopen and does not clear them on Refresh',async()=>{
  const {root,engine,embedder}=setup();writeFileSync(path.join(root,'docs/a.md'),'# A\nPERSISTENT_ISSUE');await engine.indexAll();
  (engine as any).watcher.onError(Object.assign(Error('private'),{code:'EPERM'}),undefined,{stage:'watch',rootId:null,relativePath:'docs/a.md'});
  for(let n=0;n<3;n++)expect(engine.status().fileIndex?.issues).toMatchObject([{state:'active',relativePath:'docs/a.md'}]);
  engines.splice(engines.indexOf(engine),1);await engine.close();
  const reopened=MemoryEngine.create({root,dbPath:path.join(root,'index.db'),factsDir:'facts',sources:[{sourceClass:'docs',include:['docs/**/*.md']}]},embedder);engines.push(reopened);
  expect(reopened.status().fileIndex?.issues).toMatchObject([{state:'active',code:'EPERM'}]);
  const spy=vi.spyOn(embedder,'embed');await reopened.indexAll();expect(reopened.status().fileIndex?.state).toBe('ready');expect(spy).not.toHaveBeenCalled();
 });
 it('requires a successful scan before recovering a legacy global error',async()=>{
  const {root,engine,embedder}=setup();writeFileSync(path.join(root,'docs/a.md'),'# A\nLEGACY_ISSUE');await engine.indexAll();
  const store=(engine as any).store,diag=store.getIndexDiagnostics();diag.scans.all.globalError={category:'access',action:'old access'};store.setIndexDiagnostics(diag);
  engines.splice(engines.indexOf(engine),1);await engine.close();
  const reopened=MemoryEngine.create({root,dbPath:path.join(root,'index.db'),factsDir:'facts',sources:[{sourceClass:'docs',include:['docs/**/*.md']}]},embedder);engines.push(reopened);
  expect(reopened.status().fileIndex).toMatchObject({state:'partial',issues:[{stage:'unknown',state:'active'}]});
  expect(reopened.status(null).fileIndex?.state).toBe('ready');await reopened.indexAll();expect(reopened.status().fileIndex).toMatchObject({state:'ready',issues:[{stage:'unknown',state:'recovered'}]});
 });
});


describe('source discovery verifies actual scopes',()=>{
 it('continues observing primary when another root fails and recovers without embeddings',async()=>{
  const {root,engine,embedder}=setup(),other=mkdtempSync(path.join(tmpdir(),'memory-observer-root-'));roots.push(other);
  writeFileSync(path.join(root,'docs/a.md'),'# A\nPRIMARY_SURVIVES');writeFileSync(path.join(other,'b.md'),'# B\nOTHER_SURVIVES');
  await engine.updateSources([{sourceClass:'docs',include:['docs/**/*.md']},{sourceClass:'custom',include:['**/*.md'],root:{id:'other',path:other}}],[]);
  const watcher=(engine as any).watcher,indexer=(engine as any).indexer;await watcher.discovering;
  const original=indexer.enumerate.bind(indexer),spy=vi.spyOn(indexer,'enumerate').mockImplementation((id)=>id==='other'?Promise.reject(Object.assign(Error('private'),{code:'EACCES'})):original(id));
  await watcher.discover(true);expect(engine.status('other').fileIndex?.issues).toMatchObject([{state:'active',stage:'discovery'}]);expect(engine.status(null).fileIndex?.state).toBe('ready');
  spy.mockRestore();const embed=vi.spyOn(embedder,'embed');await watcher.discover(true);
  expect(engine.status().fileIndex?.state).toBe('ready');expect(embed).not.toHaveBeenCalled();expect(engine.expand('docs/a.md',['A'])?.text).toContain('PRIMARY_SURVIVES');
 });
 it('drops discovery results from the previous policy generation',async()=>{
  const {root,engine}=setup();writeFileSync(path.join(root,'docs/a.md'),'# A\nNO_GHOST_ISSUE');await engine.indexAll();
  const watcher=(engine as any).watcher,indexer=(engine as any).indexer;await watcher.discovering;
  let reject!:(error:unknown)=>void,entered!:()=>void;const start=new Promise<void>(resolve=>entered=resolve),held=new Promise<never>((_,r)=>reject=r);
  const spy=vi.spyOn(indexer,'enumerate').mockImplementation(()=>{entered();return held;});const discovering=watcher.discover(true);await start;
  watcher.configure((engine as any).config,indexer);reject(Object.assign(Error('late'),{code:'EPERM'}));await discovering;spy.mockRestore();
  expect(engine.status().fileIndex?.issues?.filter(issue=>issue.state==='active')).toEqual([]);
 });
});


describe('auxiliary document projection failures',()=>{
 it('keeps a verified existing body searchable when only a new context vector fails',async()=>{
  const {root,engine,embedder}=setup();writeFileSync(path.join(root,'docs/a.md'),'# A\nBODY_REMAINS_AVAILABLE');await engine.indexAll();
  (engine as any).store.writeSourceProjection(undefined,'docs/a.md');const failure=vi.spyOn(embedder,'embed').mockRejectedValue(Object.assign(Error('private provider response'),{status:429}));
  await expect(engine.indexAll()).rejects.toThrow();expect(engine.status().available?.indexedFiles).toBe(1);expect(engine.status().sourceProjection?.pendingFiles).toBe(1);expect(engine.status().fileIndex?.failures).toMatchObject([{projectionOnly:true,stage:'embeddings'}]);expect(engine.expand('docs/a.md',['A'])?.text).toContain('BODY_REMAINS_AVAILABLE');failure.mockRestore();await engine.indexAll();expect(engine.status().sourceProjection?.pendingFiles).toBe(0);expect(engine.status().fileIndex?.failures).toEqual([]);
 });
});
