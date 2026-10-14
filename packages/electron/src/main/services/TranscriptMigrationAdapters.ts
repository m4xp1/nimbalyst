/**
 * Thin adapters that bridge existing PGLite stores to the interfaces
 * expected by TranscriptTransformer / TranscriptRuntime.
 *
 * Phase 4 of canonical-transcript-deprecation: only the raw-message adapter
 * remains. The metadata adapter was tied to the dropped canonical_transform_*
 * columns on ai_sessions and is no longer needed.
 */

import type { IRawMessageStore, RawMessage } from '@nimbalyst/runtime/ai/server/transcript/TranscriptTransformer';
import { database } from '../database/PGLiteDatabaseWorker';

// ---------------------------------------------------------------------------
// IRawMessageStore -- wraps ai_agent_messages queries
// ---------------------------------------------------------------------------

export function createRawMessageStoreAdapter(): IRawMessageStore {
  return {
    async getMessages(sessionId: string, afterId?: number): Promise<RawMessage[]> {
      if (!database.isInitialized()) {
        await database.initialize();
      }

      const rows: any[] = [];
      let cursor = afterId ?? 0;
      // Keep each worker query bounded without discarding the older dialogue.
      for (;;) {
        const page = await database.query<any>(
          `SELECT id, session_id, source, direction, content, created_at, metadata, hidden
           FROM ai_agent_messages WHERE session_id = $1 AND id > $2
           ORDER BY id ASC LIMIT 500`, [sessionId, cursor],
        );
        rows.push(...page.rows);
        if (page.rows.length < 500) break;
        cursor = Number(page.rows[page.rows.length - 1].id);
        await new Promise<void>(resolve => setImmediate(resolve));
      }

      return rows.map((row: any) => {
        let metadata = row.metadata;
        if (typeof metadata === 'string') {
          try {
            metadata = JSON.parse(metadata);
          } catch {
            metadata = undefined;
          }
        }

        return {
          id: Number(row.id),
          sessionId: row.session_id,
          source: row.source,
          direction: row.direction,
          content: row.content,
          createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
          metadata: metadata ?? undefined,
          hidden: row.hidden ?? false,
        };
      });
    },
  };
}

