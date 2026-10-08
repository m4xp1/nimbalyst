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
  const engine=MemoryEngine.create({root,dbPath,factsDir:'facts',sources:[]},embedder);
  try {expect(await engine.search('кошечки')).toHaveLength(1);const hits=await engine.search('языке');expect(hits).toHaveLength(1);expect(hits[0].signals).toEqual({dense:true,sparse:true});expect(embedder.embed).toHaveBeenCalledTimes(2);}
  finally {await engine.close();rmSync(root,{recursive:true,force:true});}
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
