// @vitest-environment node
import {afterEach, describe, expect, it, vi} from 'vitest';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Indexer} from '../indexer/indexer';
import {IndexWatcher} from '../indexer/watcher';
import {SqliteStore} from '../store/sqliteStore';
import {FakeEmbedder} from './fakeEmbedder';
import type {EngineConfig, FileRecord} from '../types';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });
async function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'memory-recovery-'));
  const main = path.join(root, 'main'), attached = path.join(root, 'attached');
  mkdirSync(path.join(main, 'docs'), {recursive: true}); mkdirSync(attached);
  const config: EngineConfig = {root: main, dbPath: path.join(root, 'index.db'), factsDir: 'facts', sources: [
    {sourceClass: 'docs', include: ['docs/**/*.md']},
    {sourceClass: 'docs', include: ['*.md'], root: {id: 'attached', path: attached}},
  ]};
  const embedder = new FakeEmbedder();
  let store = new SqliteStore(config.dbPath), indexer = new Indexer(config, store, embedder);
  const files = ['docs/a.md', 'docs/b.md', 'docs/stable.md', '@attached/stable.md'];
  const absolute = (name: string) => name.startsWith('@attached/') ? path.join(attached, name.slice(10)) : path.join(main, name);
  for (const name of files) writeFileSync(absolute(name), '# Saved\nStable original body ' + name);
  await indexer.indexAll();
  cleanups.push(async () => {store.close(); rmSync(root, {recursive: true, force: true});});
  return {config, embedder, files, absolute, get store() {return store;}, get indexer() {return indexer;}, reopen() {
    store.close(); store = new SqliteStore(config.dbPath); indexer = new Indexer(config, store, embedder); return indexer;
  }};
}
const providerError = () => Object.assign(new Error('synthetic unauthorized'), {status: 401, code: 'EMBEDDING_PROVIDER_ERROR'});

describe('retained file recovery without a working embedding provider', () => {
  it('verifies unchanged primary and attached files after restart despite an earlier 401, with one provider attempt', async () => {
    const f = await fixture();
    for (const name of f.files) f.indexer.markUnavailable(name);
    const chunksBefore = f.store.loadAll().length;
    writeFileSync(f.absolute('docs/a.md'), '# Changed\nNew first body');
    writeFileSync(f.absolute('docs/b.md'), '# Changed\nNew second body');
    const indexer = f.reopen();
    const enumerate = indexer.enumerate.bind(indexer);
    vi.spyOn(indexer, 'enumerate').mockImplementation(async root => (await enumerate(root)).sort((a,b) => Number(b.sourcePath === 'docs/a.md') - Number(a.sourcePath === 'docs/a.md')));
    const embed = vi.spyOn(f.embedder, 'embed').mockRejectedValue(providerError());
    await expect(indexer.indexAll()).rejects.toMatchObject({status: 401});
    expect(embed).toHaveBeenCalledTimes(1);
    expect(indexer.unavailableFiles()).toEqual([]);
    expect(indexer.failuresForStatus().map(row => row.sourcePath).sort()).toEqual(['docs/a.md', 'docs/b.md']);
    expect(indexer.readable({sourcePath: 'docs/stable.md', refType: 'doc-file'})).toBe(true);
    expect(indexer.readable({sourcePath: '@attached/stable.md', refType: 'doc-file'})).toBe(true);
    expect(indexer.readable({sourcePath: 'docs/a.md', refType: 'doc-file'})).toBe(false);
    expect(f.store.loadAll()).toHaveLength(chunksBefore);
    expect(f.store.chunksForSource('docs/a.md')[0].text).toContain('Stable original');
  });

  it('finishes local verification in a watcher batch after a provider failure without retrying paid requests', async () => {
    const f = await fixture();
    for (const name of f.files) f.indexer.markUnavailable(name);
    writeFileSync(f.absolute('docs/a.md'), '# Changed\nNew first body');
    writeFileSync(f.absolute('docs/b.md'), '# Changed\nNew second body');
    const embed = vi.spyOn(f.embedder, 'embed').mockRejectedValue(providerError());
    const onError = vi.fn();
    const watcher = new IndexWatcher(f.config, f.indexer, () => {}, onError);
    cleanups.push(() => watcher.stop());
    const control = watcher as unknown as {pending: Map<string, 'upsert' | 'remove'>; flush(): Promise<void>};
    for (const name of f.files) control.pending.set(name, 'upsert');
    await control.flush();
    expect(embed).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(2);
    expect(f.indexer.unavailableFiles()).toEqual([]);
    expect(f.indexer.readable({sourcePath: '@attached/stable.md', refType: 'doc-file'})).toBe(true);
    expect(f.indexer.readable({sourcePath: 'docs/b.md', refType: 'doc-file'})).toBe(false);
  });

  it('does not turn a stale unlink notification into missing when the file is readable', async () => {
    const f = await fixture(); const embed = vi.spyOn(f.embedder, 'embed');
    const watcher = new IndexWatcher(f.config, f.indexer, () => {});
    cleanups.push(() => watcher.stop());
    const control = watcher as unknown as {pending: Map<string, 'remove'>; flush(): Promise<void>};
    control.pending.set('docs/stable.md', 'remove');
    await control.flush();
    expect(f.indexer.unavailableFiles()).toEqual([]);
    expect(embed).not.toHaveBeenCalled();
    rmSync(f.absolute('docs/stable.md'));
    control.pending.set('docs/stable.md', 'remove');
    await control.flush();
    expect(f.indexer.unavailableFiles()).toMatchObject([{sourcePath: 'docs/stable.md', reason: 'missing'}]);
    expect(f.store.chunksForSource('docs/stable.md').length).toBeGreaterThan(0);
  });

  it('restores a verified body after an auxiliary projection failure without calling it missing', async () => {
    const f = await fixture();
    f.indexer.markUnavailable('docs/stable.md');
    f.store.writeSourceProjection(undefined, 'docs/stable.md');
    vi.spyOn(f.embedder, 'embed').mockRejectedValue(providerError());
    await expect(f.indexer.indexFile('docs/stable.md', 'docs')).rejects.toMatchObject({projectionOnly: true});
    expect(f.indexer.unavailableFiles()).toEqual([]);
    expect(f.indexer.readable({sourcePath: 'docs/stable.md', refType: 'doc-file'})).toBe(true);
  });
});


it('recovers unchanged retained files during a source-rule reconciliation after a 401', async () => {
  const f=await fixture(); for(const name of f.files)f.indexer.markUnavailable(name);
  writeFileSync(f.absolute('docs/a.md'),'# Changed\nNew contents');
  const embed=vi.spyOn(f.embedder,'embed').mockRejectedValue(providerError());
  await expect(f.indexer.reconcile([f.absolute('docs')],f.indexer)).rejects.toMatchObject({status:401});
  expect(embed).toHaveBeenCalledTimes(1);
  expect(f.indexer.unavailableFiles().map(file=>file.sourcePath)).toEqual(['@attached/stable.md']);
  expect(f.indexer.failuresForStatus()).toMatchObject([{sourcePath:'docs/a.md',stage:'embeddings',httpStatus:401}]);
  expect(f.indexer.readable({sourcePath:'docs/stable.md',refType:'doc-file'})).toBe(true);
});

it('retains a truly missing file while recovering a different readable file', async () => {
  const f=await fixture(); for(const name of f.files)f.indexer.markUnavailable(name);
  rmSync(f.absolute('docs/b.md'));
  writeFileSync(f.absolute('docs/a.md'),'# Changed\nNew contents');
  const embed=vi.spyOn(f.embedder,'embed').mockRejectedValue(providerError());
  await expect(f.indexer.indexAll()).rejects.toMatchObject({status:401});
  expect(embed).toHaveBeenCalledTimes(1);
  expect(f.indexer.unavailableFiles()).toMatchObject([{sourcePath:'docs/b.md',reason:'missing'}]);
  expect(f.store.chunksForSource('docs/b.md').length).toBeGreaterThan(0);
});

it('verifies all file-backed entities after one provider failure without using a projection-only error for another body', async () => {
  const f=await fixture();
  const records:FileRecord[]=['a','b'].map(name=>({id:'tracker:'+name,refId:name,refType:'tracker',sourceClass:'trackers',title:name,text:'Type: idea',
    file:{path:'docs/'+name+'.md',markerKey:'trackerStatus',typeField:'type',expectedType:'idea',fields:{status:'Status'}}}));
  const text=(name:string)=>'---\ntrackerStatus:\n  type: idea\ntitle: '+name+'\nstatus: open\n---\n# Original\nSaved body';
  for(const record of records)writeFileSync(f.absolute(record.file.path),text(record.title??record.id));
  await f.indexer.syncFileRecords(records);
  for(const record of records)f.indexer.markUnavailable(record.id);
  writeFileSync(f.absolute(records[0].file.path),text('changed')+'\nChanged body');
  const embed=vi.spyOn(f.embedder,'embed').mockRejectedValue(providerError());
  await expect(f.indexer.syncFileRecords(records)).rejects.toMatchObject({status:401});
  expect(embed).toHaveBeenCalledTimes(1);
  expect(f.indexer.unavailableFiles()).toEqual([]);
  expect(f.indexer.readable({sourcePath:'tracker:b',refType:'tracker'})).toBe(true);
  expect(f.indexer.readable({sourcePath:'tracker:a',refType:'tracker'})).toBe(false);
});


it('does not transfer a context-only failure exemption to a different changed body', async () => {
  const f=await fixture();
  f.store.writeSourceProjection(undefined,'docs/a.md');
  writeFileSync(f.absolute('docs/b.md'),'# Changed\nEntirely changed contents');
  const enumerate=f.indexer.enumerate.bind(f.indexer);
  vi.spyOn(f.indexer,'enumerate').mockImplementation(async root=>(await enumerate(root)).sort((a,b)=>Number(b.sourcePath==='docs/a.md')-Number(a.sourcePath==='docs/a.md')));
  const embed=vi.spyOn(f.embedder,'embed').mockRejectedValue(providerError());
  await expect(f.indexer.indexAll()).rejects.toMatchObject({status:401});
  expect(embed).toHaveBeenCalledTimes(1);
  expect(f.indexer.failuresForStatus().find(row=>row.sourcePath==='docs/a.md')?.projectionOnly).toBe(true);
  expect(f.indexer.failuresForStatus().find(row=>row.sourcePath==='docs/b.md')?.projectionOnly).toBe(false);
  expect(f.indexer.readable({sourcePath:'docs/a.md',refType:'doc-file'})).toBe(true);
  expect(f.indexer.readable({sourcePath:'docs/b.md',refType:'doc-file'})).toBe(false);
});
