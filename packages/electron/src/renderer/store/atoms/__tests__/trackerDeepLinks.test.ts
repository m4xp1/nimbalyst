import { describe, expect, it } from 'vitest';
import {
  buildTrackerDeepLink,
  buildTrackerDocumentDeepLink,
  buildFileTrackerDeepLink,
  buildTrackerRecordDeepLink,
} from '../../../utils/collabArtifactDeepLinks';
import { parseTrackerDeepLink } from '../../../../shared/trackerDeepLinks';

describe('tracker deep-link URLs', () => {
  it('builds and parses the backward-compatible link without a view', () => {
    const url = buildTrackerDeepLink('tracker/one', 'org one');

    expect(url).toBe('nimbalyst://tracker/tracker%2Fone?orgId=org%20one');
    expect(parseTrackerDeepLink(url)).toEqual({
      trackerId: 'tracker/one',
      orgId: 'org one',
    });
  });

  it('builds and parses view=document through the options argument', () => {
    const url = buildTrackerDeepLink('tracker/one', 'org one', {
      view: 'document',
    });

    expect(url).toBe(
      'nimbalyst://tracker/tracker%2Fone?orgId=org%20one&view=document',
    );
    expect(parseTrackerDeepLink(url)).toEqual({
      trackerId: 'tracker/one',
      orgId: 'org one',
      view: 'document',
    });
  });

  it('provides the document-link helper without handling the clipboard', () => {
    expect(buildTrackerDocumentDeepLink('tracker-2', 'org-2')).toBe(
      'nimbalyst://tracker/tracker-2?orgId=org-2&view=document',
    );
  });

  it('rejects unsupported tracker view values at the URL boundary', () => {
    expect(() => parseTrackerDeepLink(
      'nimbalyst://tracker/tracker-1?orgId=org-1&view=detail',
    )).toThrow(/unsupported view/i);
  });

  it('accepts a portable file-card link without an organization or machine path', () => {
    const link = buildFileTrackerDeepLink('card-123', { view: 'document' });
    expect(link).toBe('nimbalyst://tracker/card-123?scope=files&view=document');
    expect(parseTrackerDeepLink(link)).toEqual({ trackerId: 'card-123', orgId: '', scope: 'files', view: 'document' });
  });

  it('uses stable file IDs only for new managed cards and retains legacy organization links', () => {
    const managed = { id: 'p:workspacehash:card-123', source: 'frontmatter' as const, fields: { trackerFormat: 1, portableId: 'card-123' } };
    expect(buildTrackerRecordDeepLink(managed, 'org-1')).toBe('nimbalyst://tracker/card-123?scope=files');
    expect(buildTrackerRecordDeepLink({ ...managed, id: 'p:another-clone:card-123' }, null)).toBe('nimbalyst://tracker/card-123?scope=files');
    expect(buildTrackerRecordDeepLink({ id: 'legacy', source: 'frontmatter', fields: {} }, 'org-1')).toBe('nimbalyst://tracker/legacy?orgId=org-1');
    expect(buildTrackerRecordDeepLink({ id: 'legacy', source: 'native', fields: {} }, null)).toBeNull();
    expect(buildTrackerRecordDeepLink({ ...managed, fields: { trackerFormat: 1, portableId: managed.id } }, 'org-1')).toBeNull();
  });

  it('refuses a workspace-local projection ID in a portable link', () => {
    expect(() => parseTrackerDeepLink('nimbalyst://tracker/p%3Aworkspacehash%3Acard-123?scope=files')).toThrow(/portable/i);
    expect(() => parseTrackerDeepLink('nimbalyst://tracker/card-123')).toThrow(/orgId/);
  });
});
