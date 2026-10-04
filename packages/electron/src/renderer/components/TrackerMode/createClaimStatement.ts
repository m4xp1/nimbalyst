/**
 * Start a new statement (a `claim` item) about a tracker item, with the
 * subject and predicate already filled in. The detail pane's claim-stored
 * properties offer this beside each current value; the caller opens the new
 * claim so the value, `asOf` and citations can be entered there.
 *
 * Item creation is Electron-only, so this lives beside the other create helpers
 * rather than in the runtime section that renders the affordance.
 */

import {
  buildTrackerCreatePayload,
  formatTrackerValidationErrors,
  globalRegistry,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import { getRecordTitle } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerRecordAccessors';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';

export const CLAIM_TRACKER_TYPE = 'claim';

/** Whether this workspace can hold statements at all. */
export function canCreateClaimStatements(): boolean {
  const model = globalRegistry.get(CLAIM_TRACKER_TYPE);
  return !!model && model.creatable !== false;
}

/** Create the claim and resolve to its id. */
export async function createClaimStatement(params: {
  workspacePath: string;
  subject: TrackerRecord;
  predicateId: string;
}): Promise<string> {
  const { workspacePath, subject, predicateId } = params;
  const subjectTitle = getRecordTitle(subject) || subject.issueKey || subject.id;
  const predicateLabel = globalRegistry.getPredicate(predicateId)?.label ?? predicateId;

  const built = buildTrackerCreatePayload(
    CLAIM_TRACKER_TYPE,
    {
      title: `${subjectTitle}: ${predicateLabel}`,
      fields: {
        subject: {
          itemId: subject.id,
          title: subjectTitle,
          trackerType: subject.primaryType,
          ...(subject.issueKey ? { issueKey: subject.issueKey } : {}),
        },
        predicate: predicateId,
      },
    },
    { workspacePath },
  );
  if (!built.ok) throw new Error(formatTrackerValidationErrors(built.errors));

  const result = await window.electronAPI.documentService.createTrackerItem(built.payload);
  if (!result.success) throw new Error(result.error || 'Failed to create the statement');
  return result.item?.id ?? built.payload.id;
}
