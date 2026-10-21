// @vitest-environment node
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, rmSync as unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Indexer } from '../indexer/indexer.js';
import { SqliteStore } from '../store/sqliteStore.js';
import { Retriever } from '../retrieval/retriever.js';
import { FakeEmbedder } from './fakeEmbedder.js';
import type { EngineConfig } from '../types.js';

const roots: string[] = [];
function setup(): { root: string; config: EngineConfig } {
  const root = mkdtempSync(path.join(tmpdir(), 'mem-idx-'));
  roots.push(root);
  mkdirSync(path.join(root, 'docs'), { recursive: true });
  const config: EngineConfig = {
    root,
    dbPath: path.join(root, 'index.db'),
    factsDir: 'voice-memory',
    sources: [{ sourceClass: 'docs', include: ['docs/**/*.md'] }],
  };
  return { root, config };
}
afterEach(() => {
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('Indexer', () => {
  it('indexes markdown, embeds chunks, and makes them searchable', async () => {
    const { root, config } = setup();
    writeFileSync(
      path.join(root, 'docs/voice.md'),
      '# Voice Agent\nThe realtime voice agent calls grounding tools over MCP.'
    );
    writeFileSync(path.join(root, 'docs/cooking.md'), '# Bread\nHow to bake sourdough.');

    const store = new SqliteStore(config.dbPath);
    const indexer = new Indexer(config, store, new FakeEmbedder());
    const result = await indexer.indexAll();
    expect(result.files).toBe(2);
    expect(result.indexed).toBeGreaterThanOrEqual(2);

    const retriever = new Retriever(store.loadAll());
    const embedder = new FakeEmbedder();
    const [qv] = await embedder.embed(['realtime voice grounding']);
    const hits = retriever.search('realtime voice grounding', qv, 2);
    expect(hits[0].sourcePath).toBe('docs/voice.md');
    store.close();
  });

  it('re-embeds only changed chunks on the next pass', async () => {
    const { root, config } = setup();
    const a = path.join(root, 'docs/a.md');
    const b = path.join(root, 'docs/b.md');
    writeFileSync(a, '# A\nalpha content here');
    writeFileSync(b, '# B\nbeta content here');

    const store = new SqliteStore(config.dbPath);
    const indexer = new Indexer(config, store, new FakeEmbedder());
    await indexer.indexAll();

    // Edit only a.md; b.md is unchanged.
    writeFileSync(a, '# A\nalpha content here, now revised');
    const reembedA = await indexer.indexFile('docs/a.md', 'docs');
    const reembedB = await indexer.indexFile('docs/b.md', 'docs');
    expect(reembedA).toBeGreaterThanOrEqual(1);
    expect(reembedB).toBe(0); // unchanged ⇒ reused embedding
    store.close();
  });

  it('excludes files matching config.exclude (e.g. archive/**) from index + classify', async () => {
    const { root, config } = setup();
    config.exclude = ['**/archive/**'];
    mkdirSync(path.join(root, 'docs/archive'), { recursive: true });
    writeFileSync(path.join(root, 'docs/current.md'), '# Current\nlive truth');
    writeFileSync(path.join(root, 'docs/archive/old.md'), '# Old\nstale abandoned plan');

    const store = new SqliteStore(config.dbPath);
    const indexer = new Indexer(config, store, new FakeEmbedder());
    await indexer.indexAll();
    // Only the non-archived file is indexed.
    expect(store.sourcePaths()).toEqual(['docs/current.md']);
    // classify (used by the watcher) also rejects excluded paths.
    expect(indexer.classify('docs/archive/old.md')).toBeNull();
    expect(indexer.classify('docs/current.md')?.sourceClass).toBe('docs');
    store.close();
  });

  it('prunes files deleted from disk', async () => {
    const { root, config } = setup();
    writeFileSync(path.join(root, 'docs/keep.md'), '# Keep\nstays');
    const gone = path.join(root, 'docs/gone.md');
    writeFileSync(gone, '# Gone\nremoved later');

    const store = new SqliteStore(config.dbPath);
    const indexer = new Indexer(config, store, new FakeEmbedder());
    await indexer.indexAll();
    expect(store.sourcePaths().sort()).toEqual(['docs/gone.md', 'docs/keep.md']);

    unlinkSync(gone, { force: true });
    await indexer.indexAll();
    expect(store.sourcePaths()).toEqual(['docs/keep.md']);
    store.close();
  });
});

/**
 * A second root breaks the assumption that "relative to root" is a unique key.
 * These cover the collision itself and the pruning that keys off it — a same-named
 * file in two roots must not let one root's deletion evict the other's row.
 */
describe('Indexer with a second source root', () => {
  function setupTwoRoots(): { root: string; second: string; config: EngineConfig } {
    const { root, config } = setup();
    const secondHome = mkdtempSync(path.join(tmpdir(), 'mem-idx-second-'));
    roots.push(secondHome);
    const second = path.join(secondHome, 'memory');
    mkdirSync(second, { recursive: true });
    config.sources = [
      { sourceClass: 'docs', include: ['docs/**/*.md'] },
      {
        sourceClass: 'harness-memory',
        include: ['**/*.md'],
        root: { id: 'memory', path: second, personal: true },
      },
    ];
    return { root, second, config };
  }

  it('keys a same-named file in each root distinctly, and reads each back', async () => {
    const { root, second, config } = setupTwoRoots();
    writeFileSync(path.join(root, 'docs/README.md'), '# Readme\nprimary copy');
    writeFileSync(path.join(second, 'README.md'), '# Readme\nsecond-root copy');

    const store = new SqliteStore(config.dbPath);
    const indexer = new Indexer(config, store, new FakeEmbedder());
    const result = await indexer.indexAll();
    expect(result.files).toBe(2);
    // Without the root prefix these two collide on the chunk primary key and one
    // silently overwrites the other.
    expect(store.sourcePaths().sort()).toEqual(['@memory/README.md', 'docs/README.md']);

    const bySource = new Map(
      store.sourcePaths().map((sp) => [sp, store.chunksForSource(sp).map((c) => c.text).join('')])
    );
    expect(bySource.get('docs/README.md')).toContain('primary copy');
    expect(bySource.get('@memory/README.md')).toContain('second-root copy');

    // refId is the openable identifier. A caller resolves a relative one against
    // the workspace path, which cannot reach a second root — so those chunks
    // carry an absolute path or the hit is findable but not openable.
    expect(store.chunksForSource('docs/README.md')[0].refId).toBe('docs/README.md');
    expect(store.chunksForSource('@memory/README.md')[0].refId).toBe(
      path.join(second, 'README.md')
    );
    store.close();
  });

  it('attributes deletion pruning to the root the file was removed from', async () => {
    const { root, second, config } = setupTwoRoots();
    writeFileSync(path.join(root, 'docs/README.md'), '# Readme\nprimary copy');
    const secondReadme = path.join(second, 'README.md');
    writeFileSync(secondReadme, '# Readme\nsecond-root copy');

    const store = new SqliteStore(config.dbPath);
    const indexer = new Indexer(config, store, new FakeEmbedder());
    await indexer.indexAll();

    unlinkSync(secondReadme, { force: true });
    await indexer.indexAll();
    expect(store.sourcePaths()).toEqual(['docs/README.md']);
    store.close();
  });

  it('classifies by root, so a glob on one root never claims the other root files', async () => {
    const { root, second, config } = setupTwoRoots();
    // 'docs/**/*.md' belongs to the primary root only.
    mkdirSync(path.join(second, 'docs'), { recursive: true });
    writeFileSync(path.join(second, 'docs/x.md'), '# X\nunder the second root');
    writeFileSync(path.join(root, 'docs/x.md'), '# X\nunder the primary root');

    const store = new SqliteStore(config.dbPath);
    const indexer = new Indexer(config, store, new FakeEmbedder());

    expect(indexer.classify(path.join(root, 'docs/x.md'))).toEqual({
      sourceClass: 'docs',
      sourcePath: 'docs/x.md',
    });
    // Matched by the second root's own '**/*.md', NOT by the primary 'docs' set.
    expect(indexer.classify(path.join(second, 'docs/x.md'))).toEqual({
      sourceClass: 'harness-memory',
      sourcePath: '@memory/docs/x.md',
    });
    // Outside every root.
    expect(indexer.classify(path.join(tmpdir(), 'nowhere-at-all', 'docs/x.md'))).toBeNull();
    store.close();
  });
});


describe('bounded source embeddings', () => {
  it('indexes long headings, continuous payloads and page vectors without dropping the tail', async () => {
    const { root, config } = setup();config.pageVectors=true;
    const heading = 'ДлинныйЗаголовок😀'.repeat(700);
    const raw = '# ' + heading + '\n\n' + 'Qx7Zm9'.repeat(20000) + '\n\nTAILPROBE624';
    writeFileSync(path.join(root, 'docs/large.md'), raw);
    const store = new SqliteStore(config.dbPath);
    try {
      const fake = new FakeEmbedder();
      const requests: string[] = [];
      const embedder = { info: fake.info, embed: async (texts: string[]) => {
        expect(texts.every(text => Buffer.byteLength(text, 'utf8') <= 6000)).toBe(true);
        requests.push(...texts); return fake.embed(texts);
      }};
      const indexer = new Indexer(config, store, embedder);
      await indexer.indexAll();
      const rows = store.chunksForSource('docs/large.md');
      expect(rows.some(row => row.granularity === 'page')).toBe(true);
      expect(rows.filter(row => row.granularity !== 'page').every(row => row.headingPath[0] === heading)).toBe(true);
      expect(rows.some(row => row.text.includes('TAILPROBE624'))).toBe(true);
      const sent = requests.length;
      await indexer.indexAll();
      expect(requests).toHaveLength(sent);
    } finally { store.close(); }
  });
});


describe('changed heading context',()=>{
 it('refreshes unchanged body vectors when their heading context changes',async()=>{
  const {root,config}=setup();const body='stablebody '.repeat(700),file=path.join(root,'docs/context.md');
  writeFileSync(file,'# OriginalContext\n\n'+body);
  const store=new SqliteStore(config.dbPath),fake=new FakeEmbedder(),sent:string[]=[];
  const indexer=new Indexer(config,store,{info:fake.info,embed:async texts=>{sent.push(...texts);return fake.embed(texts);}});
  try{
   await indexer.indexAll();const before=sent.length;
   writeFileSync(file,'# UpdatedContext\n\n'+body);await indexer.indexAll();
   expect(sent.length-before).toBe(store.chunksForSource('docs/context.md').length+1);
   expect(sent.slice(before).filter(input=>input.startsWith('File: '))).toHaveLength(1);
   expect(sent.slice(before).every(input=>input.includes('UpdatedContext'))).toBe(true);
  }finally{store.close();}
 });
});


describe('source projection migration and reuse',()=>{
 it('reuses full-input vectors when ordinals shift, and keeps precise source coordinates',async()=>{
  const {root,config}=setup(),file=path.join(root,'docs/shift.md'),fake=new FakeEmbedder(),sent:string[]=[];
  const embedder={info:fake.info,embed:async(texts:string[])=>{sent.push(...texts);return fake.embed(texts);}},store=new SqliteStore(config.dbPath),indexer=new Indexer(config,store,embedder);
  try{
   writeFileSync(file,'# A\nFirst\n# B\nSecond');await indexer.indexAll();sent.length=0;
   const raw='# New\nAdded\n# A\nFirst\n# B\nSecond';writeFileSync(file,raw);await indexer.indexAll();
   expect(sent.filter(input=>!input.startsWith('File: '))).toHaveLength(1);expect(sent[0]).toContain('Added');expect(sent.filter(input=>input.startsWith('File: '))).toHaveLength(1);
   const chunks=store.chunksForSource('docs/shift.md');expect(chunks.every(c=>c.granularity!=='page')).toBe(true);
   for(const c of chunks){expect(c.embeddingInputHash).toMatch(/^[a-f0-9]{64}$/);expect(raw.slice(c.sourceRange!.start,c.sourceRange!.end)).toBe(c.text);}
  }finally{store.close();}
 });
 it('backfills old metadata without embedding an identical old input or retaining an unused page row',async()=>{
  const {root,config}=setup();writeFileSync(path.join(root,'docs/old.md'),'# A\nFirst\n# B\nSecond');config.pageVectors=true;
  const fake=new FakeEmbedder(),sent:string[]=[];const embedder={info:fake.info,embed:async(texts:string[])=>{sent.push(...texts);return fake.embed(texts);}},store=new SqliteStore(config.dbPath);
  try{
   await new Indexer(config,store,embedder).indexAll();
   store.upsertChunks(store.loadAll().map(c=>({...c,sourceRange:undefined,sectionId:undefined,context:undefined,embeddingInputHash:undefined,projectionVersion:undefined})));
   sent.length=0;await new Indexer({...config,pageVectors:false},store,embedder).indexAll();
   expect(sent).toEqual([]);expect(store.loadAll()).toHaveLength(2);expect(store.loadAll().every(c=>c.projectionVersion===3&&c.sectionId&&c.sourceRange)).toBe(true);
  }finally{store.close();}
 });
});


describe('document search metadata projection',()=>{
 it('persists typed frontmatter and a bounded document context separately from quoteable chunks',async()=>{
  const {root,config}=setup(),raw='---\ntitle: Точка продолжения\ndescription: Текущее состояние и следующий шаг проекта\naliases: [checkpoint, Возобновление]\ntags: [процесс]\ndoc_kind: checkpoint\nnested:\n  enabled: false\n  count: 0\n---\n# Продолжение работы\n## Следующий шаг\nНастроить искусственный сервер.\n';
  writeFileSync(path.join(root,'docs/CHECKPOINT.md'),raw);const store=new SqliteStore(config.dbPath),embedder=new FakeEmbedder(),indexer=new Indexer(config,store,embedder);
  try{await indexer.indexAll();const records=(store as any).sourceSearchRecords?.();expect(records).toHaveLength(1);expect(records[0]).toMatchObject({sourcePath:'docs/CHECKPOINT.md',fileName:'CHECKPOINT.md',fields:{title:['Точка продолжения'],doc_kind:['checkpoint'],'nested.enabled':['false'],'nested.count':['0'],aliases:['checkpoint','Возобновление']}});
   expect(records[0].context).toContain('Следующий шаг');expect(records[0].context).not.toContain(root);expect(Buffer.byteLength(records[0].context)).toBeLessThanOrEqual(6000);expect(store.count()).toBe(store.loadAll().length);for(const chunk of store.loadAll())expect(raw.slice(chunk.sourceRange!.start,chunk.sourceRange!.end)).toBe(chunk.text);
  }finally{store.close();}
 });
 it('refreshes keyword-only fields without embedding the body or the unchanged document context',async()=>{
  const {root,config}=setup(),file=path.join(root,'docs/a.md');writeFileSync(file,'---\ntitle: Stable title\ncustom_id: OLD_FIELD\n---\n# Main\nStable body.');
  const store=new SqliteStore(config.dbPath),embedder=new FakeEmbedder(),indexer=new Indexer(config,store,embedder);
  try{await indexer.indexAll();const original=store.loadAll(),embed=vi.spyOn(embedder,'embed'),upsert=vi.spyOn(store,'upsertChunks');writeFileSync(file,'---\ntitle: Stable title\ncustom_id: NEW_FIELD\n---\n# Main\nStable body.');await indexer.indexAll();expect((store as any).sourceSearchRecords?.()[0].fields.custom_id).toEqual(['NEW_FIELD']);expect(embed).not.toHaveBeenCalled();expect(upsert).not.toHaveBeenCalled();expect(store.loadAll()).toEqual(original);
  }finally{store.close();}
 });
 it('preserves malformed YAML as literal searchable text and supports metadata-only documents',async()=>{
  const {root,config}=setup();writeFileSync(path.join(root,'docs/invalid.md'),'---\ntitle: [BROKEN_FRONTMATTER\n---\n# Body\nKept body.');writeFileSync(path.join(root,'docs/only.md'),'---\ntitle: METADATA_ONLY_MARKER\n---\n');const store=new SqliteStore(config.dbPath),indexer=new Indexer(config,store,new FakeEmbedder());
  try{await indexer.indexAll();expect(store.chunksForSource('docs/invalid.md').map(c=>c.text).join('')).toContain('BROKEN_FRONTMATTER');expect(store.chunksForSource('docs/only.md').map(c=>c.text).join('')).toContain('METADATA_ONLY_MARKER');expect((store as any).sourceSearchRecords?.().find((r:any)=>r.sourcePath==='docs/invalid.md')).toMatchObject({warning:'invalid-frontmatter',fields:{}});
  }finally{store.close();}
 });
});


describe('document metadata lifecycle',()=>{
 it('fills an old index with only the missing context vector, survives reopen, and prunes deleted metadata',async()=>{
  const {root,config}=setup(),file=path.join(root,'docs/a.md'),fake=new FakeEmbedder(),inputs:string[]=[];writeFileSync(file,'# Main\nLIFECYCLE_BODY');
  const embedder={info:fake.info,embed:async(texts:string[])=>{inputs.push(...texts);return fake.embed(texts);}};
  let store=new SqliteStore(config.dbPath);try{await new Indexer(config,store,embedder).indexAll();store.writeSourceProjection(undefined,'docs/a.md');const body=store.loadAll();store.close();store=new SqliteStore(config.dbPath);inputs.length=0;
   await new Indexer(config,store,embedder).indexAll();expect(inputs).toHaveLength(1);expect(inputs[0]).toMatch(/^File: a.md/);expect(store.loadAll()).toEqual(body);expect(store.sourceSearchRecords()).toHaveLength(1);
   store.close();store=new SqliteStore(config.dbPath);inputs.length=0;await new Indexer(config,store,embedder).indexAll();expect(inputs).toEqual([]);
   unlinkSync(file);await new Indexer(config,store,embedder).indexAll();expect(store.sourceSearchRecords()).toEqual([]);expect(store.count()).toBe(0);
  }finally{store.close();}
 });
 it('never embeds root IDs or machine paths for attached sources',async()=>{
  const {root,config}=setup(),other=mkdtempSync(path.join(tmpdir(),'metadata-attached-'));roots.push(other);writeFileSync(path.join(other,'Статус.md'),'---\ntitle: Состояние проекта\n---\n# Дальше\nСледующий шаг.');config.sources.push({sourceClass:'custom',include:['*.md'],root:{id:'opaque-id',path:other}});
  const store=new SqliteStore(config.dbPath);try{await new Indexer(config,store,new FakeEmbedder()).indexAll();const record=store.sourceSearchRecords()[0];expect(record.sourcePath).toBe('@opaque-id/Статус.md');expect(record.context).not.toContain('opaque-id');expect(record.context).not.toContain(other);expect(record.relativePath).toBe('Статус.md');expect(record.refId).toBe(path.join(other,'Статус.md'));}finally{store.close();}
 });
 it('retains cyclic YAML literally instead of losing it or following aliases forever',async()=>{
  const {root,config}=setup();writeFileSync(path.join(root,'docs/cycle.md'),'---\nself: &anchor\n  again: *anchor\nmarker: CYCLIC_YAML_MARKER\n---\n# Body\nBody.');const store=new SqliteStore(config.dbPath);try{await new Indexer(config,store,new FakeEmbedder()).indexAll();expect(store.sourceSearchRecords()[0].warning).toBe('invalid-frontmatter');expect(store.loadAll().map(c=>c.text).join('')).toContain('CYCLIC_YAML_MARKER');}finally{store.close();}
 });
});


describe('unchanged source projections',()=>{
 it('does not rewrite the auxiliary record or body during repeated unchanged scans',async()=>{
  const {root,config}=setup();writeFileSync(path.join(root,'docs/a.md'),'---\ntitle: Stable\naliases: [One, Two]\n---\n# Main\nStable body.');const store=new SqliteStore(config.dbPath),fake=new FakeEmbedder(),indexer=new Indexer(config,store,fake);
  try{await indexer.indexAll();const write=vi.spyOn(store,'writeSourceProjection'),embed=vi.spyOn(fake,'embed');for(let i=0;i<3;i++)await indexer.indexAll();expect(write).not.toHaveBeenCalled();expect(embed).not.toHaveBeenCalled();}finally{store.close();}
 });
});
