# @nimbalyst/memory-engine

A host-agnostic **project-knowledge + facts engine** exposed as an **MCP server**. It indexes markdown sources into a rebuildable shadow index and serves local keyword retrieval, optional hybrid retrieval, and durable facts to any MCP agent.

> **Extraction seam.** This package has **zero host-app imports**. It is designed to be lifted out of the Nimbalyst monorepo and published standalone without a rewrite. Anything that knows about voice, trackers, or app settings lives in the parent extension, never here.

## What it does

- **Indexes markdown** (`design/`, `docs/`, plans, `CLAUDE.md`, a facts tree — any globs you configure) into heading-aware chunks (~200–500 tokens) that carry their `sourcePath` and full `headingPath`.
- **Incremental & rebuildable.** Each chunk is SHA-256 hashed; a re-index only re-embeds chunks whose content changed. The SQLite store is disposable — delete it and it rebuilds from the markdown.
- **Local retrieval by default.** BM25 sparse keyword scoring works without a provider. When an optional dense embedder is selected, cosine and BM25 rankings are fused with **Reciprocal Rank Fusion**, then **expand-to-section** uses the heading breadcrumb.
- **Pluggable embedders** behind one interface:
  - `OpenAIEmbedder` — `text-embedding-3-small`, 1536-dim (REST, no SDK dep).
  - `LocalEmbedder` — `Xenova/bge-small-en-v1.5` ONNX via transformers.js (optional dep, lazy-loaded, offline). The app selects the quantized model from its measured registry; the standalone server can override it explicitly.
  - `SparseEmbedder` — BM25-only local search with no dense vectors or network access.
  - The store records `embedder_id`/`model`/`dims`. Switching the embedder produces non-comparable vectors, so the engine **wipes and forces a full re-index**.
- **Legacy markdown facts.** The standalone `remember` command currently appends `.md` files with YAML frontmatter (`category`/`scope`/`priority`). The v3 tracker-backed record, resolution, redaction, and dedup modules are exported separately; callers must not describe the standalone command as tracker-backed until the host persistence adapter is wired.

## Bounded inputs and source failures

Chunk bodies are split on Unicode code-point boundaries to at most 5,000 UTF-8 bytes, including continuous words. Embedding heading context is separately bounded; each input is at most 6,000 UTF-8 bytes. The OpenAI adapter validates inputs before sending them and batches at most 128 texts / 240,000 UTF-8 bytes. Stored bodies and heading paths retain their full content across chunks. The page overview is a bounded embedding prefix, not a replacement for document chunks. Changing heading context invalidates reused vectors.

Per-source read/input failures are persisted in derived index metadata and quarantine old search/expand content until recovery or deletion. Other files continue; provider-wide failures stop the current embedding pass. Status exposes safe source paths and error categories rather than provider response text. The watcher starts independently of the initial scan, waits for concurrent scans and handles removals before pending upserts. Empty or failed scans do not disable observation.

The desktop host can request root-scoped status (undefined = All, null = main, string = attached root ID). Counts and failures are scoped; physical database size is only reported for All. The standalone MCP status contract remains compatible.

## Editable source rules

Source settings use only Include/Exclude arrays. Tree actions and manual edits share those arrays: a narrower path takes precedence, so Include `docs/myfile.md` can re-enable one file inside Exclude `docs`. Equal specificity favors exclusion. Glob exclusions remain effective alongside broad includes; literal filenames from tree actions are escaped. Legacy `overrides` settings are read, validated and migrated into the arrays; they are not retained as a second hidden state.

## MCP tools

| Tool | Purpose |
| --- | --- |
| `search_project_knowledge(query, k=5)` | Local keyword or hybrid search → top chunks with citations and capability data |
| `expand(sourcePath, headingPath[])` | Expand a hit to its full heading section |
| `read_doc(path)` | Read a managed document by relative path (root-guarded) |
| `remember(text, category?, scope?, priority?)` | Append a durable fact (ADD-only) |
| `recall(query?, category?, scope?, limit?)` | Recall facts, newest-wins on conflict |
| `index()` | Run an incremental index pass |
| `status()` | Index size, active embedder, re-index-needed flag |

## Running

```sh
pnpm run build            # tsc → dist/
node dist/serve.js       # stdio MCP server
```

Configuration is supplied **explicitly at launch** — the engine never reads an API key from the ambient environment as an implicit app credential.

| Env var | Default | Notes |
| --- | --- | --- |
| `NIMBALYST_MEMORY_ROOT` | `cwd` | Index/resolve root |
| `NIMBALYST_MEMORY_DB` | `<root>/.nimbalyst-memory/index.db` | Shadow index (rebuildable) |
| `NIMBALYST_MEMORY_FACTS_DIR` | `nimbalyst-local/voice-memory` | Facts tree (relative) |
| `NIMBALYST_MEMORY_CONFIG` | — | JSON file overriding `sources`/`chunk` |
| `NIMBALYST_MEMORY_EMBEDDER` | `sparse` | `sparse` \| `openai` \| `local` |
| `NIMBALYST_MEMORY_OPENAI_KEY` | — | Explicit value when selecting the OpenAI embedder; otherwise sparse mode is used |
| `NIMBALYST_MEMORY_OPENAI_MODEL` / `_DIMS` / `_BASEURL` | `text-embedding-3-small` / `1536` / — | |
| `NIMBALYST_MEMORY_LOCAL_MODEL` | `Xenova/bge-small-en-v1.5` | LocalEmbedder model |
| `NIMBALYST_BETTER_SQLITE3_NATIVE` | — | Explicit native binding path (ABI portability) |

The server connects immediately and serves partial/empty results while the initial index runs in the background; the file watcher then keeps it fresh.

## Programmatic use

```ts
import { MemoryEngine, createEmbedder } from '@nimbalyst/memory-engine';

const embedder = await createEmbedder({ kind: 'sparse' });
const engine = MemoryEngine.create(
  { root, dbPath, factsDir, sources: [{ sourceClass: 'docs', include: ['docs/**/*.md'] }] },
  embedder
);
await engine.indexAll();
const hits = await engine.search('how does voice grounding work?', 5);
```

## Layout

```
src/
  chunker.ts            heading-aware markdown chunking
  hash.ts               SHA-256 dirty check
  frontmatter.ts        YAML frontmatter parsing
  types.ts              Chunk, Embedder interface, config
  embedders/            SparseEmbedder, OpenAIEmbedder, LocalEmbedder, factory
  store/sqliteStore.ts  rebuildable SQLite shadow index
  retrieval/            cosine, bm25, rrf, hybrid Retriever
  indexer/              walk→chunk→hash→embed→upsert + watcher
  facts/facts.ts        markdown-first ADD-only facts
  engine.ts             MemoryEngine orchestrator
  mcp/server.ts         MCP adapter over the engine
  serve.ts              thin stdio launcher
```


Search scope: `list_sources` returns configured folder IDs. Pass optional `rootIds` to `search_project_knowledge` for one or several folders (`null` means the main root); omit for All. Empty/unknown IDs are errors, never a fallback to All. Filtering happens before retrieval candidate limits and RRF. Responses add `sourceScope` and each hit's `rootId`; existing fields remain compatible. This standalone server does not discover desktop attached folders or offer live `read_session`. Successful query vectors use a 32-entry, five-minute cache scoped to the engine/provider with concurrent-request sharing; errors are retried rather than cached.

## Document fields and ranking (Windows fork)

File search indexes the basename, relative path and YAML scalar values, including nested fields and arrays. Exact technical spellings remain searchable alongside normalized Russian word forms. Strong matches of a complete filename, title, description or alias take precedence over incidental body mentions. General keys, dates, `active` and particular filenames carry no authority bonus. Malformed YAML stays available literally and produces a diagnostic warning instead of silently disappearing.

One bounded semantic context per file contains its name, relative path, selected metadata and heading outline. It supplements complete body chunks. Search candidates are limited to 50 distinct entities per direction before the unchanged RRF fusion (weights 1 / 0.5, constant 8). UI and agent search share this order and return one original citable fragment per entity; optional `matchedFields` explains metadata evidence separately. Use exact names/metadata for addressed lookup, then inspect the actual source to establish freshness and authority. Use `expand` for the indexed section, `read_doc` for file content and desktop `read_session` for current dialogue. Durable-fact `recall` keeps its existing purpose and ranking.

The versioned file projection is reconciled incrementally. Metadata-only keyword edits do not regenerate body embeddings. Unchanged document-context inputs reuse their vectors; completed projections survive restart. Context rows are auxiliary and do not inflate Coverage file or ordinary chunk counts. Pending contexts and malformed metadata are visible in Coverage.

Coverage separates active issues from operation history. Issues name the source scope, discovery/watch/read/embeddings stage, safe category/code and time. A successful check recovers only the matching area; a different file or root cannot clear it. An active observer does not imply an error-free index. Legacy unknown-scope errors require a successful complete source check and observation readiness; Refresh only reads status. Recovery requires no automatic Rebuild or re-embedding. Detached-root generations cannot restore their old errors.
