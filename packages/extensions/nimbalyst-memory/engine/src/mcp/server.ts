/**
 * MCP server adapter over MemoryEngine. Thin: it maps tool calls to engine
 * methods and serializes results as JSON text content. Any MCP client (the
 * Nimbalyst coding agent today, the voice bridge later, or a third-party agent)
 * gets the same surface.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import type { MemoryEngine } from '../engine.js';
import {MEMORY_ROOT_IDS_SCHEMA} from '../types.js';
import { buildProjectSearchResponse, buildPublicEngineStatus } from '../searchResponse.js';

const TOOLS = [
  {name:'list_sources',description:'List configured Memory source folders and their rootId values for scoped search. The primary workspace has rootId null.',inputSchema:{type:'object',properties:{}}},
  {
    name: 'search_project_knowledge',
    description: "Search indexed project documents with hybrid semantic and keyword retrieval. Discover and select roots with list_sources and rootIds; omit rootIds for All. Search also matches filenames, relative paths and YAML values; title, description and aliases can provide strong field matches. Use an exact name or metadata phrase for an addressed lookup. Each result is an entity with an original citable fragment; optional matchedFields explains field evidence. Rank and filename are retrieval signals, not proof of freshness or authority: inspect the source and its current project context. Use expand for the indexed section and read_doc for the source; session history requires the desktop read_session tool when available.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language or keyword query.' },
        k: { type: 'number', description: 'Max results (default 5).' },
        rootIds:MEMORY_ROOT_IDS_SCHEMA,
      },
      required: ['query'],
    },
  },
  {
    name: 'expand',
    description:
      'Expand a search hit to its full heading section. Pass the sourcePath and ' +
      'headingPath from a search_project_knowledge result. Pass its sectionId, when present, to distinguish repeated headings.',
    inputSchema: {
      type: 'object',
      properties: {
        sourcePath: { type: 'string' },
        headingPath: { type: 'array', items: { type: 'string' } },
        sectionId: {type:'string'},
      },
      required: ['sourcePath'],
    },
  },
  {
    name: 'read_doc',
    description: 'Read a managed document by its relative path (e.g. a plan file).',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'remember',
    description:
      'Append a durable fact to memory (ADD-only; never overwrites). Use for ' +
      'preferences and project truths worth recalling later; record a project ' +
      'decision where the project records decisions, not only here.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        category: { type: 'string' },
        scope: { type: 'string' },
        priority: { type: 'number', description: 'Higher = injected sooner at start.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'recall',
    description:
      'Recall stored facts, optionally filtered by category/scope and ranked by a ' +
      'query. Newest wins when facts conflict.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        category: { type: 'string' },
        scope: { type: 'string' },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'index',
    description:
      'Run an incremental index pass over the configured sources. Returns the ' +
      'number of (re)embedded chunks and files scanned.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'status',
    description: 'Report index size, the active embedder, and whether a re-index is needed.',
    inputSchema: { type: 'object', properties: {} },
  },
] as const;

function jsonResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

export function createMcpServer(engine: MemoryEngine): Server {
  const server = new Server(
    { name: 'nimbalyst-memory-engine', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS as unknown as object[] }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name } = req.params;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    try {
      switch (name) {
        case 'list_sources':return jsonResult({sources:engine.listSources().map(root=>({rootId:root.id,label:root.label,path:root.path,available:root.available}))});
        case 'search_project_knowledge': {
          const query = String(args.query ?? '');
          if (!query) throw new McpError(ErrorCode.InvalidParams, 'query is required');
          const k = typeof args.k === 'number' ? args.k : 5;
          const rootIds=args.rootIds as Array<string|null>|undefined,sourceScope=engine.searchScope(rootIds);
          const chunks = (await engine.search(query,k,{rootIds})).map(hit=>({...hit,rootId:engine.sourceRootOf(hit.sourcePath,hit.sourceClass)}));
          return jsonResult({...buildProjectSearchResponse(chunks, engine.retrievalCapabilities()),sourceScope});
        }
        case 'expand': {
          const sourcePath = String(args.sourcePath ?? '');
          if (!sourcePath) throw new McpError(ErrorCode.InvalidParams, 'sourcePath is required');
          const headingPath = Array.isArray(args.headingPath)
            ? (args.headingPath as unknown[]).map(String)
            : [];
          return jsonResult(engine.expand(sourcePath, headingPath,typeof args.sectionId==='string'?args.sectionId:undefined));
        }
        case 'read_doc': {
          const p = String(args.path ?? '');
          if (!p) throw new McpError(ErrorCode.InvalidParams, 'path is required');
          return jsonResult(await engine.readDoc(p));
        }
        case 'remember': {
          const text = String(args.text ?? '');
          if (!text) throw new McpError(ErrorCode.InvalidParams, 'text is required');
          const written = await engine.remember({
            text,
            category: args.category != null ? String(args.category) : null,
            scope: args.scope != null ? String(args.scope) : null,
            priority: typeof args.priority === 'number' ? args.priority : 0,
          });
          return jsonResult({ ok: true, path: written });
        }
        case 'recall': {
          return jsonResult({
            facts: await engine.recall({
              query: args.query != null ? String(args.query) : undefined,
              category: args.category != null ? String(args.category) : undefined,
              scope: args.scope != null ? String(args.scope) : undefined,
              limit: typeof args.limit === 'number' ? args.limit : undefined,
            }),
          });
        }
        case 'index': {
          return jsonResult(await engine.indexAll());
        }
        case 'status': {
          return jsonResult(buildPublicEngineStatus(engine.status()));
        }
        default:
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      }
    } catch (err) {
      if (err instanceof McpError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
    }
  });

  return server;
}
