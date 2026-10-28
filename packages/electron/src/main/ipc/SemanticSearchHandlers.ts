import { safeHandle } from '../utils/ipcRegistry';
import {
  SemanticCatalogService,
  type SemanticSearchResult,
} from '../services/SemanticCatalogService';

/** Stable rejection marker for renderer callers that want an unavailable state. */
export const SEMANTIC_SEARCH_UNAVAILABLE = 'SEMANTIC_SEARCH_UNAVAILABLE';

/**
 * IPC for Quick Open global semantic search. Workspace-scoped: the renderer
 * passes its `workspacePath` explicitly (no module-level "current workspace").
 * Availability fails closed; query rejects with a stable marker when the
 * engine is not ready so callers can distinguish that from a valid empty list.
 */
export function registerSemanticSearchHandlers() {
  safeHandle('semantic-search:tracker-ids',async(_event,workspacePath:string,ids:string[],rootIds?:Array<string|null>)=>{
    if(!workspacePath||!Array.isArray(ids)||ids.some(id=>typeof id!=='string'))throw Error('workspacePath and tracker IDs are required');
    return SemanticCatalogService.getInstance().filterTrackerIds(workspacePath,ids,rootIds);
  });
  safeHandle(
    'semantic-search:available',
    async (_event, workspacePath: string): Promise<boolean> => {
      if (!workspacePath) return false;
      return SemanticCatalogService.getInstance().checkAvailability(workspacePath);
    },
  );

  safeHandle(
    'semantic-search:query',
    async (
      _event,
      workspacePath: string,
      query: string,
      k?: number,
      sourceClasses?: string[],
      rootIds?:Array<string|null>,
    ): Promise<SemanticSearchResult[]> => {
      if (!workspacePath || !query?.trim()) return [];
      const outcome = await SemanticCatalogService.getInstance().query(
        workspacePath,
        query,
        k ?? 20,
        Array.isArray(sourceClasses) && sourceClasses.length ? sourceClasses : undefined,
        rootIds,
        "interface",
      );
      if (!outcome.available) {
        throw new Error(`${SEMANTIC_SEARCH_UNAVAILABLE}: memory index is not ready`);
      }
      return outcome.results;
    },
  );

  // Session indexing opt-in (off by default). Toggled from the Project Memory
  // settings panel; flipping it (un)backfills sessions across wired workspaces.
  safeHandle('semantic-search:get-index-sessions', async (): Promise<boolean> => {
    return SemanticCatalogService.getInstance().sessionsEnabled();
  });

  safeHandle('semantic-search:get-session-indexing-error', async (): Promise<string | null> => {
    return SemanticCatalogService.getInstance().sessionIndexingError();
  });

  safeHandle(
    'semantic-search:set-index-sessions',
    async (_event, enabled: boolean): Promise<{ ok: true }> => {
      await SemanticCatalogService.getInstance().setSessionsEnabled(!!enabled);
      return { ok: true };
    },
  );
}
