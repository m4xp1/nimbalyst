// @vitest-environment node
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { tokenize, termFrequencies, Bm25Index } from '../retrieval/bm25.js';
import { SqliteStore } from '../store/sqliteStore.js';
import { MemoryEngine } from '../engine.js';
import { FactsStore } from '../facts/facts.js';
import { FakeEmbedder } from './fakeEmbedder.js';
const dirs:string[]=[];
function root(){const r=mkdtempSync(path.join(tmpdir(),'unicode-memory-')); dirs.push(r);return r;}
afterEach(()=>{for(const r of dirs.splice(0)) rmSync(r,{recursive:true,force:true});});
describe('Unicode lexical index',()=>{
 it('normalizes Russian, composed Unicode and preserves technical tokens',()=>{
   expect(tokenize('ЁЛКА елка Й И\u0306 src/main.ts foo_bar release-v1 42')).toEqual(['елка','елка','src/main.ts','foo_bar','release-v1','42']);
   const index=new Bm25Index([{id:'ru',tf:termFrequencies('Проверка сборки установщика')},{id:'en',tf:termFrequencies('installer checksum')}]);
   expect(index.search('проверка')[0].id).toBe('ru'); expect(index.search('checksum')[0].id).toBe('en');
 });
 it('matches sentence-final words and identifiers with punctuation',()=>{
   const text='Интерфейс продукта должен быть на русском языке. Янтарныймаяк! Открой src/main.ts.';
   expect(tokenize(text)).toContain('языке');expect(tokenize(text)).toContain('src/main.ts');
   const index=new Bm25Index([{id:'fact',tf:termFrequencies(text)}]);
   for(const q of ['языке','ЯНТАРНЫЙМАЯК','src/main.ts'])expect(index.search(q)[0]?.id).toBe('fact');
 });
 it('migrates old sparse terms on open without embeddings or resetting vectors',async()=>{
   const r=root(), dbPath=path.join(r,'index.db'), embedder=new FakeEmbedder();
   const store=new SqliteStore(dbPath);store.setEmbedderInfo(embedder.info);
   store.upsertChunks([{id:'ru#0',sourcePath:'docs/ru.md',sourceClass:'docs',headingPath:['Сборка'],ordinal:0,text:'Проверка установщика.',contentHash:'stable',denseEmbedding:[1,2,3],sparseTerms:{'установщика.':1},embedderId:embedder.info.id,model:embedder.info.model,dims:embedder.info.dims,updatedAt:7,refType:'doc-file',refId:'docs/ru.md'}]);
   (store as any).db.prepare("UPDATE meta SET value='2' WHERE key='lexical_version'").run();
   const before=store.loadAll()[0];store.close();
   const spy=vi.spyOn(embedder,'embed');
   const engine=MemoryEngine.create({root:r,dbPath,factsDir:'facts',sources:[]},embedder);
   expect(spy).not.toHaveBeenCalled();await engine.close();
   const reopened=new SqliteStore(dbPath);const after=reopened.loadAll()[0];
   expect(after.sparseTerms).toEqual(termFrequencies('Сборка\nПроверка установщика.'));
   expect({...after,sparseTerms:before.sparseTerms}).toEqual(before);
   expect(new Bm25Index([{id:after.id,tf:after.sparseTerms}]).search('установщика')[0].id).toBe('ru#0');
   reopened.close();
 });
 it('recalls Russian facts locally',async()=>{
   const store=new FactsStore(root(),'facts');await store.remember({text:'Ёлка украшена гирляндой'});
   expect((await store.recall({query:'елка'}))[0].text).toContain('Ёлка');
 });
});
