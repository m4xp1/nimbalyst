// @vitest-environment node
import { describe,it,expect,vi } from 'vitest';
import { mkdtempSync,rmSync } from 'node:fs';import { tmpdir } from 'node:os';import path from 'node:path';
import { SqliteStore } from '../store/sqliteStore.js';import { MemoryEngine } from '../engine.js';
import { Retriever } from '../retrieval/retriever.js';
import { termFrequencies } from '../retrieval/bm25.js';
import type { StoredChunk } from '../types.js';
const vector=(cosine:number)=>[cosine,Math.sqrt(1-cosine*cosine)];
function chunk(id:string,text:string,cosine:number,granularity:'chunk'|'page'='chunk'):StoredChunk {
 return {id,sourcePath:id+'.md',sourceClass:'docs',headingPath:[],ordinal:0,text,contentHash:id,denseEmbedding:vector(cosine),sparseTerms:granularity==='page'?{}:termFrequencies(text),embedderId:'openai',model:'text-embedding-3-small',dims:2,updatedAt:1,refType:'doc-file',refId:id+'.md',granularity};
}
describe('semantic candidate relevance policy',()=>{
 it('restores upstream candidates when opening a saved index before a new scan',async()=>{
  const root=mkdtempSync(path.join(tmpdir(),'memory-relevance-')),dbPath=path.join(root,'index.db');
  const embedder={info:{id:'openai',model:'text-embedding-3-small',dims:2},embed:vi.fn(async(texts:string[])=>texts.map(()=>[1,0]))};
  const store=new SqliteStore(dbPath);store.setEmbedderInfo(embedder.info);store.upsertChunks([chunk('fact','Интерфейс должен быть на русском языке.',.309)]);store.close();
  // Persisted candidates remain searchable only inside the active source rules.
  const engine=MemoryEngine.create({root,dbPath,factsDir:'facts',sources:[{sourceClass:'docs',include:['fact.md']}]},embedder);
  try {expect(await engine.search('кошечки')).toHaveLength(1);const hits=await engine.search('языке');expect(hits).toHaveLength(1);expect(hits[0].signals).toEqual({dense:true,sparse:true});expect(embedder.embed).toHaveBeenCalledTimes(2);}
  finally {await engine.close();rmSync(root,{recursive:true,force:true});}
 });
 it('hides saved documents outside current source rules without rewriting their text or vectors',async()=>{
  const root=mkdtempSync(path.join(tmpdir(),'memory-saved-rules-')),dbPath=path.join(root,'index.db');
  const embedder={info:{id:'openai',model:'text-embedding-3-small',dims:2},embed:vi.fn(async(texts:string[])=>texts.map(()=>[1,0]))};
  const saved=chunk('fact','Интерфейс должен быть на русском языке.',.309);
  const store=new SqliteStore(dbPath);store.setEmbedderInfo(embedder.info);store.setSourcePathFormat(2);store.upsertChunks([saved]);const before=store.loadAll();store.close();
  try {
   for(const sources of [[],[{sourceClass:'docs',include:['other.md']}],[{sourceClass:'docs',include:['fact.md'],exclude:['fact.md']}]]) {
    const engine=MemoryEngine.create({root,dbPath,factsDir:'facts',sources},embedder);
    try {expect(await engine.search('языке')).toEqual([]);expect(engine.expand('fact.md',[])).toBeNull();}
    finally {await engine.close();}
   }
   const reopened=new SqliteStore(dbPath);try {expect(reopened.loadAll()).toEqual(before);}finally{reopened.close();}
   const included=MemoryEngine.create({root,dbPath,factsDir:'facts',sources:[{sourceClass:'docs',include:['fact.md']}]},embedder);
   try {expect((await included.search('языке')).map(hit=>hit.sourcePath)).toEqual(['fact.md']);expect(embedder.embed).toHaveBeenCalledTimes(4);}
   finally {await included.close();}
  }finally{rmSync(root,{recursive:true,force:true});}
 });
 it('returns nearest candidates even for weak similarities',()=>{
  const retriever=new Retriever([chunk('fact','Интерфейс продукта на русском языке.',.324),chunk('doc','Сравнить сумму установщика.',.126)]);
  const hits=retriever.search('кошечки',[1,0],5);
  expect(hits.map(h=>h.sourcePath)).toEqual(['fact.md','doc.md']);
  expect(hits.map(h=>h.score)).toEqual([1/9,1/10]);
  expect(hits[0].similarity?.cosine).toBeCloseTo(.324);
 });
 it('keeps a strong paraphrase and its semantic provenance',()=>{
  const retriever=new Retriever([chunk('doc','Сравнить сумму установщика.',.594),chunk('fact','Интерфейс продукта на русском языке.',.324)]);
  const hits=retriever.search('How to verify package integrity?',[1,0]);
  expect(hits.map(h=>h.sourcePath)).toEqual(['doc.md','fact.md']);expect(hits[0].signals).toEqual({dense:true,sparse:false});
 });
 it('preserves exact Russian keyword provenance alongside semantic candidates',()=>{
  const retriever=new Retriever([chunk('fact','Интерфейс должен быть на русском языке.',.309),chunk('marker','Лазурныйкомпас.',.262)]);
  for(const q of ['языке','ЛАЗУРНЫЙКОМПАС']) {const hits=retriever.search(q,[1,0]);expect(hits).toHaveLength(2);expect(hits[0].signals).toEqual({dense:true,sparse:true});}
 });
 it('keeps weak candidates in the optional page arm too',()=>{
  const page=chunk('weakpage','irrelevant',.2,'page');page.sourcePath='weak.md';
  const weak=chunk('weak','irrelevant',.1);
  expect(new Retriever([weak,page],{pageWeight:.4}).search('кошечки',[1,0])).toHaveLength(1);
 });
 it('preserves upstream two-arm RRF scores for unchanged English tokens',()=>{
  const hits=new Retriever([chunk('a','release checksum',.2),chunk('b','unrelated',.8)]).search('checksum',[1,0]);
  expect(hits.map(h=>h.sourcePath)).toEqual(['a.md','b.md']);
  expect(hits[0].score).toBeCloseTo(1/10+.5/9);
  expect(hits[1].score).toBeCloseTo(1/9);
 });
});


describe('source-level Memory ranking',()=>{
 it('limits candidates by entity rather than allowing one long document to fill the dense pool',()=>{
  const rows=Array.from({length:80},(_,i)=>({...chunk('long-'+i,'Long unrelated section '+i,.95),sourcePath:'long.md',refId:'long.md'}));const target=chunk('target','Current continuation document.',.8);
  const hits=new Retriever([...rows,target]).search('unmatched query',[1,0],5);expect(hits.map(hit=>hit.sourcePath)).toEqual(['long.md','target.md']);
 });
 it('prioritizes complete title metadata over a body quotation and exposes the matched field',async()=>{
  const {sourceSearchRecord}=await import('../sourceSearch.js');const target=chunk('canonical','Neutral body about the next concrete action.',.2),quote=chunk('quote','Как найти текущее состояние проекта?',.95);
  const record=sourceSearchRecord(target.sourcePath,'docs','---\ntitle: Текущее состояние проекта\ndescription: Состояние и следующий шаг\n---\n# Main\nNeutral body.',[target],{id:'openai',model:'text-embedding-3-small',dims:2});
  const retriever=new (Retriever as any)([quote,target],undefined,[record]);const hits=retriever.search('текущее состояние проекта',[1,0],5);expect(hits[0].sourcePath).toBe(target.sourcePath);expect(hits[0].matchedFields).toEqual(expect.arrayContaining([expect.objectContaining({field:'title',value:'Текущее состояние проекта'})]));expect(hits[0].text).toBe(target.text);
 });
 it('finds a filename without that name in the body, preserving technical path components',async()=>{
  const {sourceSearchRecord}=await import('../sourceSearch.js'),target={...chunk('item','Neutral body.',.2),sourcePath:'docs/process/CHECKPOINT.md',refId:'docs/process/CHECKPOINT.md'};
  const record=sourceSearchRecord(target.sourcePath,'docs','# Main\nNeutral body.',[target],{id:'openai',model:'text-embedding-3-small',dims:2});const retriever=new (Retriever as any)([target],undefined,[record]);
  expect(retriever.search('checkpoint',null,5)[0]).toMatchObject({sourcePath:target.sourcePath,matchedFields:expect.arrayContaining([expect.objectContaining({field:'fileName'})])});expect(retriever.search('docs/process',null,5)).toHaveLength(1);
 });
});


describe('field priority is evidence, not document authority',()=>{
 it('does not treat a single generic word, active status, or a checkpoint filename as an authority signal',async()=>{
  const {sourceSearchRecord}=await import('../sourceSearch.js'),target=chunk('CHECKPOINT','Neutral body.',.2),answer=chunk('answer','Текущее состояние системы.',.95);
  const record=sourceSearchRecord(target.sourcePath,'docs','---\ntitle: Состояние другого проекта\nknowledge_status: active\n---\n# Main\nNeutral body.',[target],{id:'openai',model:'text-embedding-3-small',dims:2});
  expect(new Retriever([target,answer],undefined,[record]).search('состояние',[1,0],5)[0].sourcePath).toBe('answer.md');
 });
});

it.each(['project','состояние','the'])('does not turn an exact generic/stop-word title into a strong field boost: %s',async query=>{
 const {sourceSearchRecord}=await import('../sourceSearch.js');const target=chunk('generic-title','Neutral body.',.2);
 const record=sourceSearchRecord(target.sourcePath,'docs','---\ntitle: '+query+'\n---\n# Main\nNeutral body.',[target],{id:'openai',model:'text-embedding-3-small',dims:2});
 const hits=new Retriever([target],undefined,[record]).search(query,null,5);
 expect(hits).toHaveLength(1);expect(hits[0].fieldPriority).toBeUndefined();
 expect(hits[0].matchedFields).toEqual(expect.arrayContaining([expect.objectContaining({field:'title',value:query})]));
});
