import type { StoredFileTracker } from './fileTrackerStore';
import { isRelationshipField, normalizeRelationshipValue } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import type { FieldDefinition } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import { encodeWorkspaceLocalId, isPortableTrackerSourceId, mapPortableTrackerRelationshipIds } from './portableTrackerIdentity';

interface ProjectionDatabase { query<T = any>(sql: string, params?: any[]): Promise<{ rows: T[] }> }
export function isPortableTrackerRow(row: { data?: unknown } | null | undefined): boolean {
  if (!row) return false;
  const data: any = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
  return data?.trackerFormat === 1;
}

/** Project current project facts; never merge removed YAML fields back from the cache. */
export async function projectPortableTracker(db: ProjectionDatabase, workspace: string, card: StoredFileTracker, comments: unknown[] = [], fieldDefs: FieldDefinition[] = []): Promise<any> {
  const localId = encodeWorkspaceLocalId(workspace, card.id);
  // Discovery from Git bypasses createTrackerItem. A raw ID already owned by a
  // local native/legacy row would make public-ID resolution choose a different
  // card from namespaced lookup, so reject it before mutating any projection.
  const rawCollision = (await db.query('SELECT id FROM tracker_items WHERE id = $1 AND workspace = $2', [card.id, workspace])).rows[0];
  if (rawCollision) throw new Error(`Tracker ID ${card.id} already belongs to a database or legacy card in this workspace`);
  const previous = (await db.query('SELECT * FROM tracker_items WHERE id = $1', [localId])).rows[0];
  if (previous && (encodeWorkspaceLocalId(previous.workspace, card.id) !== localId || !isPortableTrackerRow(previous))) {
    throw new Error(`Tracker ID ${card.id} already belongs to another workspace or a database card`);
  }
  const before = typeof previous?.data === 'string' ? JSON.parse(previous.data) : (previous?.data ?? {});
  // Existing database/legacy targets keep their IDs. Missing file targets can
  // still be indexed before they are restored, using their deterministic key.
  const references = [...new Set(fieldDefs.filter(isRelationshipField).flatMap(def => normalizeRelationshipValue(card.fields[def.name]).map(value => value.itemId)).filter(isPortableTrackerSourceId))];
  const nativeIds = new Set<string>();
  if (references.length) {
    const placeholders = references.map((_, index) => `$${index + 2}`).join(', ');
    for (const row of (await db.query(`SELECT id, data FROM tracker_items WHERE workspace = $1 AND id IN (${placeholders})`, [workspace, ...references])).rows) {
      if (!isPortableTrackerRow(row)) nativeIds.add(row.id);
    }
  }
  const data: Record<string, unknown> = { ...mapPortableTrackerRelationshipIds(workspace, card.fields, fieldDefs, 'toLocal', nativeIds), trackerFormat: 1, portableId: card.id, comments };
  // These are intentionally machine-local, and must survive projection refreshes.
  for (const key of ['linkedSessions', 'agentSessions', 'activity', 'revisions', 'kanbanSortOrder', 'metaAgent']) {
    if (before[key] !== undefined) data[key] = before[key];
  }
  const typeTags = [...new Set([card.type, ...(Array.isArray(card.fields.typeTags) ? card.fields.typeTags.filter((tag): tag is string => typeof tag === 'string') : [])])];
  const created = typeof card.fields.created === 'string' ? card.fields.created : null;
  const updated = typeof card.fields.updated === 'string' ? card.fields.updated : created;
  if (!created || !updated || !Number.isFinite(Date.parse(created)) || !Number.isFinite(Date.parse(updated))) throw new Error(`Tracker ${card.id} has invalid created/updated timestamps`);
  const archived = card.fields.archived === true;
  const archivedAt = archived ? (card.fields.archivedAt ?? updated) : null;
  const key = typeof card.fields.key === 'string' ? card.fields.key : null;
  if (previous && JSON.stringify(before) === JSON.stringify(data) && previous.source_ref === card.relativePath
    && previous.type === card.type && previous.issue_key === key && Boolean(previous.archived) === archived
    && JSON.stringify(typeof previous.type_tags === 'string' ? JSON.parse(previous.type_tags) : previous.type_tags) === JSON.stringify(typeTags)) return previous;
  await db.query(`INSERT INTO tracker_items (
    id, type, type_tags, data, workspace, document_path, line_number, created, updated, last_indexed,
    sync_status, content, archived, archived_at, source, source_ref, issue_key
  ) VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $8, NOW(), 'local', NULL, $9, $10, 'frontmatter', $6, $11)
  ON CONFLICT (id) DO UPDATE SET type = $2, type_tags = $3, data = $4, document_path = $6,
    created = $7, updated = $8, last_indexed = NOW(), content = NULL, archived = $9, archived_at = $10,
    source_ref = $6, issue_key = $11`,
  [localId, card.type, typeTags, JSON.stringify(data), workspace, card.relativePath, created, updated, archived, archivedAt, key]);
  return (await db.query('SELECT * FROM tracker_items WHERE id = $1', [localId])).rows[0];
}
