// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { FieldDefinition } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import { encodeWorkspaceLocalId, decodeWorkspaceLocalId, mapPortableTrackerRelationshipIds } from '../portableTrackerIdentity';

const defs: FieldDefinition[] = [
  { name: 'dependsOn', type: 'relationship', multiValue: true },
  { name: 'ownerPage', type: 'reference', multiValue: false },
  { name: 'description', type: 'text' },
];
describe('portable tracker workspace identity', () => {
  it('keeps file IDs stable and separates local workspace IDs', () => {
    const first = encodeWorkspaceLocalId('C:/Repo/one', 'card-123');
    expect(first).toBe(encodeWorkspaceLocalId('c:\\repo\\one\\', 'card-123'));
    expect(first).not.toBe(encodeWorkspaceLocalId('C:/Repo/two', 'card-123'));
    expect(decodeWorkspaceLocalId('C:/Repo/one', first)).toBe('card-123');
    expect(decodeWorkspaceLocalId('C:/Repo/one', 'native-item')).toBeNull();
    expect(() => decodeWorkspaceLocalId('C:/Repo/two', first)).toThrow(/another workspace/);
    expect(() => decodeWorkspaceLocalId('C:/Repo/one', 'p:broken')).toThrow(/Invalid/);
  });
  it('maps only schema references and preserves reference metadata and ordinary text', () => {
    const fields = { description: 'other-card', freeform: { itemId: 'other-card' }, dependsOn: [{ itemId: 'other-card', title: 'Other', trackerType: 'task', relationshipTypeKey: 'blocks' }], ownerPage: 'owner-card' };
    const local = mapPortableTrackerRelationshipIds('/workspace/first', fields, defs, 'toLocal');
    expect(local.description).toBe(fields.description);
    expect(local.freeform).toBe(fields.freeform);
    expect(local.dependsOn).toEqual([{ ...fields.dependsOn[0], itemId: encodeWorkspaceLocalId('/workspace/first', 'other-card') }]);
    expect(local.ownerPage).toEqual({ itemId: encodeWorkspaceLocalId('/workspace/first', 'owner-card') });
    expect(fields.dependsOn[0].itemId).toBe('other-card');
    const restored = mapPortableTrackerRelationshipIds('/workspace/first', local, defs, 'toPortable');
    expect(restored.dependsOn).toEqual(fields.dependsOn);
    expect(restored.ownerPage).toEqual({ itemId: 'owner-card' });
  });
  it('preserves explicit native targets and rejects foreign local references', () => {
    const fields = { dependsOn: ['native-card', 'portable-card'] };
    expect(mapPortableTrackerRelationshipIds('/workspace/first', fields, defs, 'toLocal', new Set(['native-card'])).dependsOn)
      .toEqual([{ itemId: 'native-card' }, { itemId: encodeWorkspaceLocalId('/workspace/first', 'portable-card') }]);
    const foreign = { dependsOn: [{ itemId: encodeWorkspaceLocalId('/workspace/other', 'portable-card') }] };
    for (const direction of ['toLocal', 'toPortable'] as const) {
      expect(() => mapPortableTrackerRelationshipIds('/workspace/first', foreign, defs, direction)).toThrow(/another workspace/);
    }
  });
});
