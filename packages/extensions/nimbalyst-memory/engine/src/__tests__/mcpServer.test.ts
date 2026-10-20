// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { MemoryEngine } from '../engine.js';
import { SparseEmbedder } from '../embedders/sparseEmbedder.js';
import { createMcpServer } from '../mcp/server.js';
import { FakeEmbedder } from './fakeEmbedder.js';
import type { Embedder, EngineConfig } from '../types.js';

const roots: string[] = [];
afterEach(() => {
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function bootEngine(
  mode: 'hybrid' | 'keyword-only' | 'query-failure' = 'hybrid',
): Promise<MemoryEngine> {
  const root = mkdtempSync(path.join(tmpdir(), 'mem-mcp-'));
  roots.push(root);
  mkdirSync(path.join(root, 'docs'), { recursive: true });
  writeFileSync(
    path.join(root, 'docs/voice.md'),
    '# Voice Agent\nThe realtime voice agent calls grounding tools over MCP for sub-second answers.'
  );
  const config: EngineConfig = {
    root,
    dbPath: path.join(root, 'index.db'),
    factsDir: 'voice-memory',
    sources: [{ sourceClass: 'docs', include: ['docs/**/*.md'] }],
  };
  const fake = new FakeEmbedder();
  let calls = 0;
  const queryFailure: Embedder = {
    info: fake.info,
    async embed(texts) {
      calls += 1;
      if (calls > 1) throw new Error('Invalid API key credential detail');
      return fake.embed(texts);
    },
  };
  const embedder =
    mode === 'keyword-only'
      ? new SparseEmbedder()
      : mode === 'query-failure'
        ? queryFailure
        : fake;
  const engine = MemoryEngine.create(config, embedder);
  await engine.indexAll();
  return engine;
}

async function connect(engine: MemoryEngine): Promise<Client> {
  const server = createMcpServer(engine);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
  await client.connect(clientT);
  return client;
}

function parse(result: unknown): unknown {
  const r = result as { content: { type: string; text: string }[] };
  return JSON.parse(r.content[0].text);
}

describe('MCP server adapter (end-to-end over in-memory transport)', () => {
  it('lists the expected tools', async () => {
    const engine = await bootEngine();
    const client = await connect(engine);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ['expand', 'index', 'list_sources', 'read_doc', 'recall', 'remember', 'search_project_knowledge', 'status'].sort()
    );
    await engine.close();
  });

  it('discovers configured folders and rejects invalid search scopes without host-only tools', async()=>{
    const engine=await bootEngine('keyword-only');
    const client=await connect(engine);
    try {
      const sources=parse(await client.callTool({name:'list_sources',arguments:{}})) as any;
      expect(sources.sources).toEqual([expect.objectContaining({rootId:null,available:true})]);
      const selected=parse(await client.callTool({name:'search_project_knowledge',arguments:{query:'realtime',rootIds:[null]}})) as any;
      expect(selected.chunks[0]).toMatchObject({rootId:null,sourcePath:'docs/voice.md'});
      expect(selected.sourceScope).toEqual({mode:'selected',rootIds:[null]});
      for(const rootIds of [[],['foreign']])expect((await client.callTool({name:'search_project_knowledge',arguments:{query:'realtime',rootIds}})).isError).toBe(true);
      expect((await client.listTools()).tools.some(tool=>tool.name==='read_session')).toBe(false);
    } finally {await client.close();await engine.close();}
  });

  it('search_project_knowledge returns grounded chunks with citations', async () => {
    const engine = await bootEngine();
    const client = await connect(engine);
    const res = parse(
      await client.callTool({ name: 'search_project_knowledge', arguments: { query: 'realtime voice grounding', k: 3 } })
    ) as { chunks: { sourcePath: string; citation: string }[] };
    expect(res.chunks[0].sourcePath).toBe('docs/voice.md');
    expect(res.chunks[0].citation).toContain('docs/voice.md');
    await engine.close();
  });

  it('standalone session search preserves citations without advertising host-only reading guidance', async () => {
    const engine = await bootEngine('keyword-only');
    try {
      await engine.ingestRecords([{id:'session:standalone-child',sourceClass:'sessions',refType:'session',refId:'standalone-child',parentSessionId:'parent',title:'Dialogue',text:'StandaloneSessionMarker'}]);
      const client = await connect(engine);
      const response = parse(await client.callTool({name:'search_project_knowledge',arguments:{query:'StandaloneSessionMarker'}})) as any;
      expect(response.chunks).toHaveLength(1);
      expect(response.chunks[0]).toMatchObject({sourcePath:'session:standalone-child',refId:'standalone-child',refType:'session'});
      expect(response.chunks[0].citation).toContain('session:standalone-child');
      expect(response).not.toHaveProperty('sessionReadHint');
      expect((await client.listTools()).tools.some(t=>t.name==='read_session')).toBe(false);
      await client.close();
    } finally {await engine.close();}
  });

  it('returns structured local fallback data without credential solicitation', async () => {
    const engine = await bootEngine('keyword-only');
    const client = await connect(engine);
    const raw = await client.callTool({
      name: 'search_project_knowledge',
      arguments: { query: 'realtime voice grounding', k: 3 },
    });
    const res = parse(raw) as {
      chunks: { sourcePath: string }[];
      capabilities: {
        mode: string;
        semantic: { available: boolean; reason?: string };
        keyword: { available: boolean; source: string };
      };
      fallback: { used: boolean; kind: string; hint: string };
    };

    expect(res.chunks[0].sourcePath).toBe('docs/voice.md');
    expect(res.capabilities).toEqual({
      mode: 'keyword-only',
      semantic: {
        available: false,
        reason: 'optional-embedding-provider-unavailable',
      },
      keyword: { available: true, source: 'local-project-index' },
    });
    expect(res.fallback).toEqual({
      used: true,
      kind: 'local-keyword-index',
      hint:
        'Keyword search ran locally. If results are insufficient, use normal ' +
        'workspace file/text search over project Markdown.',
    });
    expect(JSON.stringify(raw)).not.toMatch(/api key|credential|configure.*settings/i);
    await engine.close();
  });

  it('does not expose raw provider errors through search or status', async () => {
    const engine = await bootEngine('query-failure');
    const client = await connect(engine);
    const search = await client.callTool({
      name: 'search_project_knowledge',
      arguments: { query: 'realtime voice grounding', k: 3 },
    });
    const status = await client.callTool({ name: 'status', arguments: {} });

    expect(JSON.stringify({ search, status })).not.toMatch(
      /api key|credential|configure.*settings/i,
    );
    expect(parse(search)).toMatchObject({
      capabilities: { mode: 'keyword-only', semantic: { available: false } },
      fallback: { used: true, kind: 'local-keyword-index' },
    });
    await engine.close();
  });

  it('remember then recall round-trips a fact through MCP', async () => {
    const engine = await bootEngine();
    const client = await connect(engine);
    const wrote = parse(
      await client.callTool({ name: 'remember', arguments: { text: 'Voice mode is Cmd+Shift+A', category: 'shortcut', priority: 7 } })
    ) as { ok: boolean; path: string };
    expect(wrote.ok).toBe(true);

    const recalled = parse(
      await client.callTool({ name: 'recall', arguments: { query: 'voice mode shortcut' } })
    ) as { facts: { text: string }[] };
    expect(recalled.facts.some((f) => f.text.includes('Cmd+Shift+A'))).toBe(true);
    await engine.close();
  });

  it('status reports the embedder and chunk count', async () => {
    const engine = await bootEngine();
    const client = await connect(engine);
    const status = parse(await client.callTool({ name: 'status', arguments: {} })) as {
      chunks: number;
      embedder: { id: string };
    };
    expect(status.chunks).toBeGreaterThan(0);
    expect(status.embedder.id).toBe('fake');
    await engine.close();
  });

  it('read_doc rejects path traversal outside the root', async () => {
    const engine = await bootEngine();
    const client = await connect(engine);
    const res = (await client.callTool({
      name: 'read_doc',
      arguments: { path: '../../etc/passwd' },
    })) as { isError?: boolean; content: { text: string }[] };
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/escapes engine root/);
    await engine.close();
  });
});


describe('precise indexed-section expansion',()=>{
 it('keeps repeated headings distinct through standalone MCP search and expand',async()=>{
  const engine=await bootEngine('keyword-only'),client=await connect(engine);
  try{
   writeFileSync(path.join(engine.status().root,'docs/repeated.md'),'# Repeated\nFIRST_SECTION_MARKER\n## Child\nCHILD_SECTION_MARKER\n# Repeated\nSECOND_SECTION_MARKER');await engine.indexAll();
   const result=parse(await client.callTool({name:'search_project_knowledge',arguments:{query:'FIRST_SECTION_MARKER',k:10}})) as any;
   const hit=result.chunks.find((c:any)=>c.text.includes('FIRST_SECTION_MARKER'));expect(hit).toMatchObject({sectionId:expect.any(String),sourceRange:{start:0,end:expect.any(Number)},coordinateSpace:'source-text'});
   const expanded=parse(await client.callTool({name:'expand',arguments:{sourcePath:hit.sourcePath,headingPath:hit.headingPath,sectionId:hit.sectionId}})) as any;
   expect(expanded.text).toContain('FIRST_SECTION_MARKER');expect(expanded.text).toContain('CHILD_SECTION_MARKER');expect(expanded.text).not.toContain('SECOND_SECTION_MARKER');
   expect(parse(await client.callTool({name:'expand',arguments:{sourcePath:hit.sourcePath,sectionId:'stale-section-id'}}))).toBeNull();
  }finally{await client.close();await engine.close();}
 });
});
