// @vitest-environment node
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { globBaseDir, computeWatchScope, computeWatchScopes } from '../indexer/watcher.js';
import { resolveRoots } from '../roots.js';
import type { SourceSet } from '../types.js';

describe('globBaseDir', () => {
  it('returns the static directory prefix before the first glob magic char', () => {
    expect(globBaseDir('design/**/*.md')).toBe('design');
    expect(globBaseDir('nimbalyst-local/plans/**/*.md')).toBe('nimbalyst-local/plans');
    expect(globBaseDir('docs/*.md')).toBe('docs');
  });

  it('returns empty string for root-anchored globs (no leading dir)', () => {
    expect(globBaseDir('CLAUDE.md')).toBe('');
    expect(globBaseDir('**/CLAUDE.md')).toBe('');
  });
});

describe('computeWatchScope', () => {
  const sources: SourceSet[] = [
    { sourceClass: 'design', include: ['design/**/*.md'] },
    { sourceClass: 'docs', include: ['docs/**/*.md'] },
    { sourceClass: 'plans', include: ['nimbalyst-local/plans/**/*.md'] },
    { sourceClass: 'claude', include: ['CLAUDE.md', '**/CLAUDE.md'] },
    { sourceClass: 'facts', include: ['nimbalyst-local/voice-memory/**/*.md'] },
  ];

  it('scopes watch dirs to the source bases — never the workspace root', () => {
    const { dirs } = computeWatchScope(sources);
    // The dirs are the small source trees, not '' (root) — the bug was watching
    // the entire monorepo (100k+ files → EMFILE → fetch socket starvation).
    expect(dirs).toContain('design');
    expect(dirs).toContain('docs');
    expect(dirs).toContain('nimbalyst-local/plans');
    expect(dirs).toContain('nimbalyst-local/voice-memory');
    expect(dirs).not.toContain('');
  });

  it('collects root-anchored globs separately (watched as individual files)', () => {
    const { rootAnchoredGlobs } = computeWatchScope(sources);
    expect(rootAnchoredGlobs).toContain('CLAUDE.md');
    expect(rootAnchoredGlobs).toContain('**/CLAUDE.md');
  });

  it('drops a dir that is a descendant of another watched dir', () => {
    const { dirs } = computeWatchScope([
      { sourceClass: 'a', include: ['nimbalyst-local/**/*.md'] },
      { sourceClass: 'b', include: ['nimbalyst-local/plans/**/*.md'] },
    ]);
    expect(dirs).toEqual(['nimbalyst-local']);
  });
});

describe('computeWatchScopes', () => {
  const multiRoot: SourceSet[] = [
    { sourceClass: 'docs', include: ['docs/**/*.md'] },
    { sourceClass: 'claude', include: ['CLAUDE.md'] },
    {
      sourceClass: 'harness-memory',
      include: ['**/*.md'],
      root: { id: 'memory', path: '/home/me/.claude/projects/-repo/memory', personal: true },
    },
  ];
  const roots = resolveRoots('/repo', multiRoot);

  it('groups sets by root so a base dir is never resolved against the wrong root', () => {
    const scopes = computeWatchScopes(multiRoot, roots);
    expect(scopes).toHaveLength(2);
    const primary = scopes.find((s) => s.root.id === null)!;
    expect(primary.root.dir).toBe(path.resolve('/repo'));
    expect(primary.dirs).toEqual(['docs']);
    // Root-anchored globs on the monorepo root stay file-enumerated — watching
    // that tree recursively is the EMFILE bug.
    expect(primary.rootAnchoredGlobs).toEqual(['CLAUDE.md']);
  });

  it('keeps root-anchored rules file-scoped on attached roots', () => {
    const memory = computeWatchScopes(multiRoot, roots).find((s) => s.root.id === 'memory')!;
    // Attached roots may be large; discovery finds new matches without a root watch.
    expect(memory.dirs).toEqual([]);
    expect(memory.rootAnchoredGlobs).toEqual(['**/*.md']);
  });

  it('keeps a non-primary root with real base dirs scoped to those dirs', () => {
    const sets: SourceSet[] = [
      {
        sourceClass: 'notes',
        include: ['notes/**/*.md'],
        root: { id: 'ext', path: '/elsewhere' },
      },
    ];
    const scopes = computeWatchScopes(sets, resolveRoots('/repo', sets));
    const ext = scopes.find((s) => s.root.id === 'ext')!;
    expect(ext.dirs).toEqual(['notes']);
  });
});

it('does not watch or surface errors for an unrelated ZIP and Git lock in an attached folder',async()=>{
 const fs=await import('node:fs');const os=await import('node:os');const {MemoryEngine}=await import('../engine');const {FakeEmbedder}=await import('./fakeEmbedder');const {vi}=await import('vitest');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'watch-scope-'));let engine:ReturnType<typeof MemoryEngine.create>|undefined;
 try{const primary=path.join(root,'primary'),attached=path.join(root,'attached');fs.mkdirSync(primary);fs.mkdirSync(path.join(attached,'docs'),{recursive:true});fs.mkdirSync(path.join(attached,'.git'));const zip=path.join(attached,'unselected.zip');fs.writeFileSync(zip,Buffer.from([80,75,0]));fs.writeFileSync(path.join(attached,'.git/index.lock'),'synthetic');fs.writeFileSync(path.join(attached,'docs/selected.md'),'# Selected\nALLOWED_MARKER');
 const sources:SourceSet[]=[{sourceClass:'docs',include:['docs/**/*.md','**/CLAUDE.md'],root:{id:'attached',path:attached}}];engine=MemoryEngine.create({root:primary,dbPath:path.join(root,'index.db'),factsDir:'facts',sources},new FakeEmbedder());await engine.indexAll();await (engine as any).watcher.ready();const watcher=(engine as any).watcher.watcher;expect(Object.values(watcher.getWatched()).flat()).not.toContain('unselected.zip');watcher.emit('error',Object.assign(Error('synthetic'),{path:zip,code:'EBUSY'}));expect(JSON.stringify(engine.status())).not.toContain('unselected.zip');
 fs.writeFileSync(path.join(attached,'new-CLAUDE-test.md'),'not selected');fs.mkdirSync(path.join(attached,'nested'));fs.writeFileSync(path.join(attached,'nested/CLAUDE.md'),'# New\nNEW_INSTRUCTION_MARKER');await vi.waitFor(async()=>expect((await engine!.search('NEW_INSTRUCTION_MARKER')).some(hit=>hit.text.includes('NEW_INSTRUCTION_MARKER'))).toBe(true),{timeout:8000,interval:100});
 }finally{await engine?.close();fs.rmSync(root,{recursive:true,force:true});}
});
