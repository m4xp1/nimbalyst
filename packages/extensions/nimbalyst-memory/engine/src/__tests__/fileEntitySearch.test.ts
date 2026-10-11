// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, unlinkSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MemoryEngine } from '../engine.js';
import type { FileRecord, EngineConfig } from '../types.js';
import { FakeEmbedder } from './fakeEmbedder.js';

const roots: string[] = [];
const engines: MemoryEngine[] = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.close();
  for (const root of roots.splice(0)) rmSync(root, {recursive:true,force:true});
});
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'memory-file-entity-')); roots.push(root);
  mkdirSync(path.join(root, 'docs')); mkdirSync(path.join(root, 'bugs'));
  return root;
}
function open(root: string, overrides: Partial<EngineConfig> = {}) {
  const engine = MemoryEngine.create({root,dbPath:path.join(root,'memory.db'),factsDir:'facts',sources:[{sourceClass:'docs',include:['docs/**/*.md']}],...overrides}, new FakeEmbedder());
  engines.push(engine); return engine;
}
function markdown(body: string, status = 'new') {
  return `---\ntrackerStatus:\n  type: idea\ntitle: File entity\nstatus: ${status}\n---\n${body}\n`;
}
function record(file = 'docs/card.md'): FileRecord {
  return {id:'tracker:file-card',refType:'tracker',refId:'file-card',sourceClass:'trackers',title:'File entity',text:'Type: idea',
    file:{path:file,markerKey:'trackerStatus',typeField:'type',expectedType:'idea',defaultType:'plan',fields:{status:'Status',priority:'Priority'}}};
}
async function sparse(engine: MemoryEngine, query: string, classes?: string[]) {
  return (await engine.search(query,100,classes ? {sourceClasses:classes} : undefined)).filter(hit => hit.signals.sparse);
}
describe('canonical file entity search', () => {
  it('transitions old DOCUMENT and tracker copies to one TRACKER, retaining a standalone database card', async () => {
    const root = fixture(); writeFileSync(path.join(root,'docs/card.md'),markdown('quartzfilemarker'));
    const engine = open(root); await engine.indexAll();
    await engine.ingestRecords([
      {id:'tracker:file-card',refType:'tracker',refId:'file-card',sourceClass:'trackers',title:'Legacy',text:'staleoldbody'},
      {id:'tracker:native',refType:'tracker',refId:'native',sourceClass:'trackers',title:'Native',text:'quartzfilemarker independent database body'},
    ]);
    expect((await sparse(engine,'quartzfilemarker')).some(h => h.refType === 'doc-file')).toBe(true);
    await engine.syncFileRecords([record()]);
    const hits = await sparse(engine,'quartzfilemarker');
    expect(new Set(hits.map(h => h.refId))).toEqual(new Set(['file-card','native']));
    expect(hits.every(h => h.refType === 'tracker')).toBe(true);
    expect(await sparse(engine,'staleoldbody')).toEqual([]);
    expect(await sparse(engine,'quartzfilemarker',['docs'])).toEqual([]);
    expect((await sparse(engine,'quartzfilemarker',['trackers'])).every(h => h.refType === 'tracker')).toBe(true);
  });
  it('reads changed Markdown and attributes, prunes the old text, and does not recreate DOCUMENT on Rebuild', async () => {
    const root = fixture(); const file = path.join(root,'docs/card.md'); writeFileSync(file,markdown('firstfilemarker'));
    const engine = open(root); await engine.syncFileRecords([record()]);
    writeFileSync(file,markdown('secondfilemarker','accepted')); await engine.indexAll();
    expect(await sparse(engine,'firstfilemarker')).toEqual([]);
    expect((await sparse(engine,'secondfilemarker')).every(h => h.refType === 'tracker')).toBe(true);
    expect((await sparse(engine,'accepted')).some(h => h.text.includes('Status: accepted'))).toBe(true);
    expect(await sparse(engine,'secondfilemarker',['docs'])).toEqual([]);
  });
  it('indexes outside document includes, honors exclusions, and restores ordinary document policy after marker removal', async () => {
    const root = fixture(); const file = path.join(root,'bugs/card.md'); writeFileSync(file,markdown('outsidefilemarker'));
    const engine = open(root); await engine.syncFileRecords([record('bugs/card.md')]);
    expect((await sparse(engine,'outsidefilemarker')).some(h => h.refId === 'file-card')).toBe(true);
    await engine.updateSources([{sourceClass:'docs',include:['docs/**/*.md']}],['bugs/**']);
    expect(await sparse(engine,'outsidefilemarker')).toEqual([]);
    await engine.updateSources([{sourceClass:'custom',include:['bugs/**/*.md']}],[]);
    writeFileSync(file,'# Ordinary file\nordinaryfilemarker\n'); await engine.indexAll();
    expect((await sparse(engine,'ordinaryfilemarker')).every(h => h.refType === 'doc-file' && h.sourceClass === 'custom')).toBe(true);
    expect(await sparse(engine,'outsidefilemarker')).toEqual([]);
    await engine.syncFileRecords([]);
    expect((await sparse(engine,'ordinaryfilemarker')).some(h => h.refType === 'doc-file')).toBe(true);
  });
  it('does not fall back to the old index when a file is deleted or unreadable', async () => {
    const root = fixture(); const file = path.join(root,'docs/card.md'); writeFileSync(file,markdown('unavailablefilemarker'));
    const engine = open(root); await engine.syncFileRecords([record()]);
    unlinkSync(file); await engine.indexAll();
    expect(await sparse(engine,'unavailablefilemarker')).toEqual([]);
    writeFileSync(file,markdown('returnedfilemarker')); await engine.indexAll();
    expect((await sparse(engine,'returnedfilemarker')).some(h => h.refType === 'tracker')).toBe(true);
    writeFileSync(file,Buffer.from([0xff,0xfe,0,0])); await engine.indexAll();
    expect(await sparse(engine,'returnedfilemarker')).toEqual([]);
  });
  it('keeps the entity identifier after rename, accepts separator variants, and evicts old file paths', async () => {
    const root = fixture(); writeFileSync(path.join(root,'docs/card.md'),markdown('renamedfilemarker'));
    const engine = open(root); await engine.syncFileRecords([record('docs\\card.md')]);
    renameSync(path.join(root,'docs/card.md'),path.join(root,'bugs/renamed.md'));
    await engine.syncFileRecords([record('bugs/renamed.md')]); await engine.indexAll();
    const hits = await sparse(engine,'renamedfilemarker');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every(h => h.refId === 'file-card' && h.refType === 'tracker')).toBe(true);
  });
  it('restores ownership after restart and withholds the old body until the actual file is verified', async () => {
    const root = fixture(); const file = path.join(root,'docs/card.md'); writeFileSync(file,markdown('beforerestartmarker'));
    const first = open(root); await first.syncFileRecords([record()]); await first.close(); engines.splice(engines.indexOf(first),1);
    writeFileSync(file,markdown('afterrestartmarker'));
    const reopened = open(root);
    expect(await sparse(reopened,'beforerestartmarker')).toEqual([]);
    await reopened.indexAll();
    expect((await sparse(reopened,'afterrestartmarker')).some(h => h.refId === 'file-card')).toBe(true);
    expect(await sparse(reopened,'beforerestartmarker')).toEqual([]);
  });
  it('updates and removes an owned file through the real watcher outside include masks', async () => {
    const root = fixture(); const file = path.join(root,'bugs/card.md'); writeFileSync(file,markdown('watchbeforemarker'));
    const engine = open(root); engine.startWatching(); await engine.syncFileRecords([record('bugs/card.md')]);
    writeFileSync(file,markdown('watchaftermarker'));
    await vi.waitFor(async () => expect((await sparse(engine,'watchaftermarker')).some(h => h.refId === 'file-card')).toBe(true),{timeout:10000,interval:100});
    expect(await sparse(engine,'watchbeforemarker')).toEqual([]);
    unlinkSync(file);
    await vi.waitFor(async () => expect(await sparse(engine,'watchaftermarker')).toEqual([]),{timeout:10000,interval:100});
  });
  it('keeps archived file entities suppressed rather than exposing a DOCUMENT clone', async () => {
    const root = fixture(); writeFileSync(path.join(root,'docs/card.md'),markdown('archivedfilemarker'));
    const engine = open(root); await engine.indexAll();
    const archived = record(); archived.file.disabled = true; await engine.syncFileRecords([archived]); await engine.indexAll();
    expect(await sparse(engine,'archivedfilemarker')).toEqual([]);
  });
});
