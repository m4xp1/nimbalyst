// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, unlinkSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryEngine } from '../../../../../extensions/nimbalyst-memory/engine/src/engine';
import { FakeEmbedder } from '../../../../../extensions/nimbalyst-memory/engine/src/__tests__/fakeEmbedder';

const { host, services, settings } = vi.hoisted(() => ({
  host: { list: vi.fn(() => []), getState: vi.fn(() => ({status:'running'})), onStateChanged: vi.fn(), request: vi.fn() },
  services: new Map(), settings: new Map(),
}));
vi.mock('../../extensions/PrivilegedExtensionHost', () => ({getPrivilegedExtensionHost: () => host}));
vi.mock('../../window/WindowManager', () => ({documentServices: services}));
vi.mock('../../utils/store', () => ({getAppSetting: (key:string) => settings.get(key), setAppSetting: vi.fn()}));
import { SemanticCatalogService } from '../SemanticCatalogService';

let root: string;
let engine: MemoryEngine;
let catalog: SemanticCatalogService;
afterEach(async () => {
  (catalog as any)?.unwireWorkspace(root);
  await engine?.close();
  services.clear(); settings.clear(); vi.clearAllMocks();
  if (root) rmSync(root,{recursive:true,force:true});
});
function md(body:string) { return `---\ntrackerStatus:\n  type: idea\ntitle: Current file title\nstatus: accepted\n---\n${body}\n`; }
async function setup() {
  root = mkdtempSync(path.join(tmpdir(),'catalog-file-search-'));
  mkdirSync(path.join(root,'bugs'));
  engine = MemoryEngine.create({root,dbPath:path.join(root,'memory.db'),factsDir:'facts',sources:[]},new FakeEmbedder());
  catalog = new SemanticCatalogService();
  let items: any[] = [
    {id:'file',type:'idea',title:'Stale title',source:'frontmatter',sourceRef:'bugs/card.md',documentPath:'bugs/card.md',workspace:root,content:'staledatabasebody'},
    {id:'native',type:'idea',title:'Native',source:'manual',documentPath:'bugs/card.md',content:'nativedatabasebody'},
  ];
  const callbacks: {tracker?: (event:any)=>void; file?:()=>void} = {};
  services.set(root, {
    listTrackerItems: async () => items,
    watchTrackerItems: (cb:any) => {callbacks.tracker=cb; return () => {};},
    watchDocumentMetadata: (cb:any) => {callbacks.file=cb; return () => {};},
  });
  host.request.mockImplementation(async ({method,params}:any) => {
    if (method === 'syncFileRecords') return engine.syncFileRecords(params.records,params.obsoleteIds);
    if (method === 'ingestRecords') return engine.ingestRecords(params.records);
    if (method === 'removeRecords') return engine.removeRecords(params.ids);
    if (method === 'clearSessionRecords') return {removed:0};
    if (method === 'status') return {ready:true,...engine.status()};
    return {results:[]};
  });
  writeFileSync(path.join(root,'bugs/card.md'),md('freshfilemarker'));
  (catalog as any).wireWorkspace(root);
  await (catalog as any).backfillTrackers(root);
  const flush = async () => {
    const pending = (catalog as any).wired.get(root).pending;
    clearTimeout(pending.timer); pending.timer = null;
    await (catalog as any).flush(root);
  };
  const sparse = async (word:string) => (await engine.search(word,100)).filter(h=>h.signals?.sparse);
  return {callbacks,flush,sparse,setItems:(next:any[])=>{items=next;},getItems:()=>items};
}
describe('application file catalogue → actual Memory search', () => {
  it('forwards selected roots without changing readiness on invalid scope',async()=>{
    await setup();
    vi.spyOn(catalog,'isAvailable').mockReturnValue(true);
    const invalidate=vi.spyOn(catalog as any,'invalidateReadiness');
    host.request.mockImplementation(async({method}:any)=>{if(method==='globalSearch')throw Error('MEMORY_SOURCE_SCOPE_INVALID: detached');return {ready:true,...engine.status()};});
    const before=catalog.isAvailable(root);
    await expect(catalog.query(root,'marker',20,['docs'],['link'])).rejects.toThrow('MEMORY_SOURCE_SCOPE_INVALID');
    expect(host.request).toHaveBeenCalledWith(expect.objectContaining({method:'globalSearch',params:{query:'marker',k:20,sourceClasses:['docs'],rootIds:['link']}}));
    expect(catalog.isAvailable(root)).toBe(before);expect(invalidate).not.toHaveBeenCalled();
  });
  it('keeps one searchable card for legacy Windows separator aliases with different metadata', async () => {
    const {setItems,getItems,callbacks,flush,sparse} = await setup();
    const file = getItems()[0];
    setItems([
      {...file,id:'fm:idea:bugs/card.md'},
      {...file,id:'fm:idea:bugs\\card.md',sourceRef:'bugs\\card.md',documentPath:'bugs\\card.md',title:'Other stale alias title'},
      getItems()[1],
    ]);
    callbacks.file!(); await flush();
    const hits = await sparse('freshfilemarker');
    expect(hits).toHaveLength(1);
    expect(hits[0].refType).toBe('tracker');
    expect(await sparse('staledatabasebody')).toEqual([]);
    expect((await sparse('nativedatabasebody')).map(h=>h.refId)).toEqual(['native']);
  });
  it('indexes the current file outside document includes and preserves an independent DB card with a documentPath', async () => {
    const {sparse} = await setup();
    expect((await sparse('freshfilemarker')).map(h=>h.refId)).toEqual(['file']);
    expect(await sparse('staledatabasebody')).toEqual([]);
    expect((await sparse('nativedatabasebody')).map(h=>h.refId)).toEqual(['native']);
    const descriptor = host.request.mock.calls.find(([p])=>p.method==='syncFileRecords')![0].params.records[0];
    expect(descriptor.text).not.toContain('freshfilemarker');
    expect(descriptor.text).not.toContain('staledatabasebody');
  });
  it('refreshes via metadata events, handles removal/recreation, and evicts unreadable content', async () => {
    const {callbacks,flush,sparse,getItems} = await setup();
    writeFileSync(path.join(root,'bugs/card.md'),md('changedfilemarker'));
    callbacks.file!(); await flush();
    expect(await sparse('freshfilemarker')).toEqual([]);
    expect((await sparse('changedfilemarker')).map(h=>h.refId)).toEqual(['file']);
    callbacks.tracker!({added:[],updated:[],removed:['file']});
    // The projection was recreated with the same identity before the debounce.
    expect(getItems().some(item=>item.id==='file')).toBe(true);
    await flush();
    expect((await sparse('changedfilemarker')).map(h=>h.refId)).toEqual(['file']);
    unlinkSync(path.join(root,'bugs/card.md')); callbacks.file!(); await flush();
    expect(await sparse('changedfilemarker')).toEqual([]);
    expect((await sparse('nativedatabasebody')).map(h=>h.refId)).toEqual(['native']);
  });
});
