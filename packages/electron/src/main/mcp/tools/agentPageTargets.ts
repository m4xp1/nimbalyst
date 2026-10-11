/**
 * Pages an agent reads and edits through `readCollabDoc` / `applyCollabDocEdit`:
 * shared pages (`collab://`), typed-page bodies (`collab://tracker-content/<id>`)
 * and Personal pages (`personal://`, Decision 20).
 *
 * The success text names the page, `Updated "<title>" (<uri>)`, which is what
 * the transcript's "Updated <page>" line shows.
 */

import { globalRegistry } from '@nimbalyst/tracker-schema';
import { getDatabase } from '../../database/initialize';
import { getEffectiveTrackerSharingPolicy, shouldSyncTrackerItem } from '../../services/TrackerPolicyService';
import { isPersonalPageUri, parsePersonalPageUri } from '../../../shared/personalPageUri';
import { getDocumentServiceForWorkspace, resolveTrackerItemFromDocumentService, resolveTrackerRowByReference } from './trackerToolItemAccess';
import { rowToTrackerItem } from './trackerToolHandlers';
import { isFileTracker } from '../../services/tracker/fileTrackerBody';

const TEAM_TYPED_PAGE_PREFIX = 'collab://tracker-content/';

export function isAgentPageUri(uri: string | undefined): uri is string {
  return !!uri && (uri.startsWith('collab://') || isPersonalPageUri(uri));
}

/** The tracker item behind a typed-page body URI, team or Personal. */
export function typedPageItemId(uri: string): string | null {
  if (uri.startsWith(TEAM_TYPED_PAGE_PREFIX)) return uri.slice(TEAM_TYPED_PAGE_PREFIX.length) || null;
  const personal = parsePersonalPageUri(uri);
  return personal?.kind === 'typed-page' ? personal.itemId : null;
}

export interface TypedPageFacts {
  title: string;
  /** True when the item's body is the team's collaborative document. */
  shared: boolean;
}

export async function describeTypedPage(itemId: string, workspacePath: string | undefined): Promise<TypedPageFacts | null> {
  const db = getDatabase();
  if (!db) return null;
  const row = await resolveTrackerRowByReference(db as any, itemId, workspacePath);
  if (!row) {
    const { docService } = await getDocumentServiceForWorkspace(workspacePath);
    const fileItem = await resolveTrackerItemFromDocumentService(docService, itemId);
    return fileItem && isFileTracker(fileItem) ? { title: String(fileItem.title || itemId), shared: false } : null;
  }
  if (isFileTracker(row)) return { title: String(rowToTrackerItem(row).title || itemId), shared: false };
  const item = rowToTrackerItem(row);
  const workspace = row.workspace || workspacePath;
  const shared = workspace
    ? shouldSyncTrackerItem(getEffectiveTrackerSharingPolicy(workspace, row.type, globalRegistry.get(row.type)), item)
    : false;
  return { title: String(item.title || itemId), shared };
}

/** Both legacy page URI schemes must reach the same authoritative file route. */
export async function fileTrackerPageUri(uri: string, workspacePath: string | undefined): Promise<string> {
  const itemId = typedPageItemId(uri);
  if (!itemId || !workspacePath) return uri;
  const db = getDatabase();
  const row = db ? await resolveTrackerRowByReference(db as any, itemId, workspacePath) : null;
  if (row) return isFileTracker(row) ? `personal://tracker-content/${itemId}` : uri;
  const { docService } = await getDocumentServiceForWorkspace(workspacePath);
  const item = await resolveTrackerItemFromDocumentService(docService, itemId);
  return item && isFileTracker(item) ? `personal://tracker-content/${itemId}` : uri;
}

/**
 * Refuse a Personal typed-page URI for an item whose body is the team's: that
 * write would land in the local copy and be replaced by the room's.
 */
export async function personalTypedPageError(uri: string, workspacePath: string | undefined): Promise<string | null> {
  const personal = isPersonalPageUri(uri) ? parsePersonalPageUri(uri) : null;
  if (!personal) return isPersonalPageUri(uri) ? `Error: Not a Personal page URI: ${uri}` : null;
  if (personal.kind !== 'typed-page') return null;
  const facts = await describeTypedPage(personal.itemId, workspacePath);
  if (!facts) return `Error: Unknown typed page '${personal.itemId}'.`;
  if (facts.shared) {
    return `Error: '${facts.title}' is shared with the team; edit its body at ${TEAM_TYPED_PAGE_PREFIX}${personal.itemId}.`;
  }
  return null;
}

export function pageUpdatedText(uri: string, title: string | undefined): string {
  return title ? `Updated "${title}" (${uri})` : `Updated ${uri}`;
}
