import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { isRelationshipField, normalizeRelationshipValue, serializeRelationshipValue } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import type { FieldDefinition } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';

const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{3,100}$/;
const LOCAL_ID = /^p:([a-f0-9]{32}):([A-Za-z0-9][A-Za-z0-9_-]{3,100})$/;

function workspaceKey(workspace: string): string {
  if (!workspace) throw new Error('A workspace is required for a portable tracker ID');
  const windows = process.platform === 'win32' || /^[A-Za-z]:[\\/]/.test(workspace) || /^\\\\/.test(workspace);
  const normalized = (windows ? path.win32.resolve(workspace).replace(/\\/g, '/').toLowerCase() : path.resolve(workspace)).normalize('NFC');
  return createHash('sha256').update(normalized).digest('hex').slice(0, 32);
}

export function isPortableTrackerSourceId(id: string): boolean { return SOURCE_ID.test(id); }

/** A rebuildable machine-local key. Never write it into Markdown or comments JSONL. */
export function encodeWorkspaceLocalId(workspace: string, portableId: string): string {
  if (!isPortableTrackerSourceId(portableId)) throw new Error('Invalid portable tracker ID');
  return `p:${workspaceKey(workspace)}:${portableId}`;
}

/** Ordinary native/legacy IDs return null. A foreign local namespace is an error. */
export function decodeWorkspaceLocalId(workspace: string, id: string): string | null {
  if (!id.startsWith('p:')) return null;
  const match = LOCAL_ID.exec(id);
  if (!match) throw new Error('Invalid workspace-local tracker ID');
  if (match[1] !== workspaceKey(workspace)) throw new Error('Tracker ID belongs to another workspace');
  return match[2];
}

/** Convert only declared references, preserving title/body/custom text byte-for-byte. */
export function mapPortableTrackerRelationshipIds(
  workspace: string,
  fields: Record<string, unknown>,
  fieldDefs: FieldDefinition[],
  direction: 'toLocal' | 'toPortable',
  nativeIds: ReadonlySet<string> = new Set(),
): Record<string, unknown> {
  const mapped = { ...fields };
  for (const def of fieldDefs) {
    if (!isRelationshipField(def) || !(def.name in fields)) continue;
    const values = normalizeRelationshipValue(fields[def.name]).map(value => {
      const sourceId = decodeWorkspaceLocalId(workspace, value.itemId);
      const itemId = direction === 'toPortable' ? sourceId ?? value.itemId
        : sourceId ? value.itemId
          : isPortableTrackerSourceId(value.itemId) && !nativeIds.has(value.itemId) ? encodeWorkspaceLocalId(workspace, value.itemId) : value.itemId;
      return { ...value, itemId };
    });
    mapped[def.name] = serializeRelationshipValue(def, values);
  }
  return mapped;
}
