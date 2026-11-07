import { isPortableTrackerLinkId, type TrackerDeepLinkView } from '../../shared/trackerDeepLinks';
import type { TrackerRecord } from '@nimbalyst/tracker-core';

export function buildSharedDocumentDeepLink(documentId: string, orgId: string): string {
  return `nimbalyst://doc/${encodeURIComponent(documentId)}?orgId=${encodeURIComponent(orgId)}`;
}

export function buildSharedFolderDeepLink(folderId: string, orgId: string): string {
  return `nimbalyst://folder/${encodeURIComponent(folderId)}?orgId=${encodeURIComponent(orgId)}`;
}

export interface BuildTrackerDeepLinkOptions {
  view?: TrackerDeepLinkView;
}

export function buildTrackerDeepLink(
  trackerId: string,
  orgId: string,
  options: BuildTrackerDeepLinkOptions = {},
): string {
  if (options.view !== undefined && options.view !== 'document') {
    throw new Error(`Unsupported tracker deep-link view: ${options.view}`);
  }
  const viewParam = options.view === 'document' ? '&view=document' : '';
  return `nimbalyst://tracker/${encodeURIComponent(trackerId)}?orgId=${encodeURIComponent(orgId)}${viewParam}`;
}

export function buildTrackerDocumentDeepLink(trackerId: string, orgId: string): string {
  return buildTrackerDeepLink(trackerId, orgId, { view: 'document' });
}

export function buildFileTrackerDeepLink(portableId: string, options: BuildTrackerDeepLinkOptions = {}): string {
  if (!isPortableTrackerLinkId(portableId)) throw new Error('File tracker link requires a portable card ID');
  if (options.view !== undefined && options.view !== 'document') throw new Error(`Unsupported tracker deep-link view: ${options.view}`);
  return `nimbalyst://tracker/${encodeURIComponent(portableId)}?scope=files${options.view === 'document' ? '&view=document' : ''}`;
}

/** Project-file IDs survive clones; local projection IDs never enter copied
 * links. Only the new managed-file marker selects this contract. */
export function buildTrackerRecordDeepLink(
  item: Pick<TrackerRecord, 'id' | 'source' | 'fields'> | null | undefined,
  orgId: string | null | undefined,
  options: BuildTrackerDeepLinkOptions = {},
): string | null {
  if (!item) return null;
  if (item.source === 'frontmatter' && item.fields.trackerFormat === 1) {
    const id = item.fields.portableId;
    return typeof id === 'string' && isPortableTrackerLinkId(id) ? buildFileTrackerDeepLink(id, options) : null;
  }
  return orgId ? buildTrackerDeepLink(item.id, orgId, options) : null;
}
