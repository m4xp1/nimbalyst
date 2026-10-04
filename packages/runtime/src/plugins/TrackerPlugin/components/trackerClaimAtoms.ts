/**
 * Claims about one item, for surfaces that show claim-stored property values.
 *
 * The index is derived from the whole tracker map, so it rebuilds whenever any
 * item changes. The per-subject atom is the isolation boundary: it hands back
 * the SAME array until a claim about that subject actually changes, so a detail
 * pane subscribed to it does not repaint when an unrelated item is edited.
 */

import { atom } from 'jotai';
import { atomFamily } from 'jotai-family';
import { readClaimRecord, type ClaimRecord } from '@nimbalyst/tracker-schema';
import { trackerItemsMapAtom } from '../trackerDataAtoms';

const NO_CLAIMS: readonly ClaimRecord[] = [];

/** Claims keyed by subject item id. A subject named by issue key is resolved to its id. */
export const trackerClaimsBySubjectAtom = atom((get) => {
  const items = get(trackerItemsMapAtom);
  const idByIssueKey = new Map<string, string>();
  for (const record of items.values()) {
    if (record.issueKey) idByIssueKey.set(record.issueKey, record.id);
  }
  const bySubject = new Map<string, ClaimRecord[]>();
  for (const record of items.values()) {
    if (record.primaryType !== 'claim') continue;
    const claim = readClaimRecord(record);
    if (!claim?.subjectId) continue;
    const subjectId = items.has(claim.subjectId) ? claim.subjectId : idByIssueKey.get(claim.subjectId) ?? claim.subjectId;
    const list = bySubject.get(subjectId);
    if (list) list.push({ ...claim, subjectId });
    else bySubject.set(subjectId, [{ ...claim, subjectId }]);
  }
  return bySubject;
});

function sameClaim(a: ClaimRecord, b: ClaimRecord): boolean {
  return a.id === b.id
    && a.updatedAt === b.updatedAt
    && a.predicate === b.predicate
    && a.status === b.status
    && a.archived === b.archived
    && a.valueText === b.valueText
    && a.objectId === b.objectId
    && JSON.stringify(a.qualifiers) === JSON.stringify(b.qualifiers);
}

export function sameClaimList(a: readonly ClaimRecord[], b: readonly ClaimRecord[]): boolean {
  return a.length === b.length && a.every((claim, index) => sameClaim(claim, b[index]!));
}

/** Claims whose subject is `subjectId`; stable identity while they are unchanged. */
export const trackerClaimsAboutAtom = atomFamily((subjectId: string) => {
  let previous: readonly ClaimRecord[] = NO_CLAIMS;
  return atom((get) => {
    const next = get(trackerClaimsBySubjectAtom).get(subjectId) ?? NO_CLAIMS;
    if (sameClaimList(previous, next)) return previous;
    previous = next;
    return next;
  });
});
