import { describe, it, expect, beforeEach } from 'vitest';
import { globalRegistry } from '@nimbalyst/tracker-schema';
import type { TrackerDataModel } from '@nimbalyst/tracker-schema';
import { propagateInverseRelationships } from '../inverseRelationshipWrites';

/**
 * Phase 3 inverse propagation orchestration. The pure delta math is covered in
 * the runtime model tests; here we verify the service wiring: the right target
 * items get the right inverse-field writes, dangling/private targets are skipped,
 * and a target type without the inverse field is left to the derived backlink.
 */

function model(type: string, fields: TrackerDataModel['fields']): TrackerDataModel {
  return {
    type,
    displayName: type,
    displayNamePlural: `${type}s`,
    icon: 'label',
    color: '#888',
    modes: { inline: true, fullDocument: false },
    idPrefix: type.toUpperCase(),
    idFormat: 'ulid',
    fields,
  };
}

const PLAN = model('plan', [
  { name: 'title', type: 'string' },
  {
    name: 'dependsOn', type: 'relationship', relationshipTypeKey: 'depends-on', multiValue: true,
    inverseFieldId: 'blockedBy', inverseRelationshipTypeKey: 'blocks',
  },
]);
const BUG = model('bug', [
  { name: 'title', type: 'string' },
  { name: 'blockedBy', type: 'relationship', relationshipTypeKey: 'blocks', multiValue: true },
]);

interface FakeTarget { id: string; type: string; typeTags?: string[]; data: Record<string, unknown> }

function makeDeps(targets: FakeTarget[]) {
  const writes: Array<{ itemId: string; fieldName: string; value: unknown }> = [];
  const byId = new Map(targets.map((t) => [t.id, t]));
  return {
    writes,
    deps: {
      loadItem: async (id: string) => byId.get(id) ?? null,
      applyTargetUpdate: async (itemId: string, fieldName: string, value: unknown) => {
        writes.push({ itemId, fieldName, value });
      },
    },
  };
}

describe('propagateInverseRelationships', () => {
  beforeEach(() => {
    globalRegistry.register(PLAN);
    globalRegistry.register(BUG);
  });

  it('writes the inverse value on a newly-linked target', async () => {
    const { writes, deps } = makeDeps([{ id: 'bug-1', type: 'bug', data: {} }]);
    const res = await propagateInverseRelationships(
      { id: 'plan-1', type: 'plan', issueKey: 'NIM-1', title: 'Plan One' },
      { dependsOn: [{ itemId: 'bug-1' }] },
      {},
      deps,
    );
    expect(res.targetsUpdated).toBe(1);
    expect(writes).toHaveLength(1);
    expect(writes[0].itemId).toBe('bug-1');
    expect(writes[0].fieldName).toBe('blockedBy');
    expect(writes[0].value).toEqual([
      expect.objectContaining({ itemId: 'plan-1', issueKey: 'NIM-1', relationshipTypeKey: 'blocks' }),
    ]);
  });

  it('removes the inverse value when a link is dropped', async () => {
    const { writes, deps } = makeDeps([
      { id: 'bug-1', type: 'bug', data: { blockedBy: [{ itemId: 'plan-1', relationshipTypeKey: 'blocks' }] } },
    ]);
    await propagateInverseRelationships(
      { id: 'plan-1', type: 'plan' },
      { dependsOn: [] },
      { dependsOn: [{ itemId: 'bug-1' }] },
      deps,
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ itemId: 'bug-1', fieldName: 'blockedBy' });
    expect(writes[0].value).toEqual([]);
  });

  it('skips targets that are not present locally (dangling/private)', async () => {
    const { writes, deps } = makeDeps([]); // bug-1 not loadable
    const res = await propagateInverseRelationships(
      { id: 'plan-1', type: 'plan' },
      { dependsOn: [{ itemId: 'bug-1' }] },
      {},
      deps,
    );
    expect(res.targetsUpdated).toBe(0);
    expect(writes).toHaveLength(0);
  });

  it('skips when the target type does not declare the inverse field', async () => {
    globalRegistry.register(model('note', [{ name: 'title', type: 'string' }]));
    const { writes, deps } = makeDeps([{ id: 'note-1', type: 'note', data: {} }]);
    await propagateInverseRelationships(
      { id: 'plan-1', type: 'plan' },
      { dependsOn: [{ itemId: 'note-1' }] },
      {},
      deps,
    );
    expect(writes).toHaveLength(0);
  });

  it('ignores relationship fields that did not change in this update', async () => {
    const { writes, deps } = makeDeps([{ id: 'bug-1', type: 'bug', data: {} }]);
    await propagateInverseRelationships(
      { id: 'plan-1', type: 'plan' },
      { title: 'renamed' }, // dependsOn absent → no propagation
      { dependsOn: [{ itemId: 'bug-1' }] },
      deps,
    );
    expect(writes).toHaveLength(0);
  });

  it('replaying creation does not write or reorder an already materialized inverse', async () => {
    const source = { itemId: 'plan-1', direction: 'out', trackerType: 'plan', title: 'Plan One', issueKey: 'NIM-1', relationshipTypeKey: 'blocks' };
    const other = { itemId: 'plan-2', direction: 'out', trackerType: 'plan', relationshipTypeKey: 'blocks' };
    const { writes, deps } = makeDeps([{ id: 'bug-1', type: 'bug', data: { blockedBy: [source, other] } }]);
    const result = await propagateInverseRelationships(
      { id: 'plan-1', type: 'plan', title: 'Plan One', issueKey: 'NIM-1' },
      { dependsOn: [{ itemId: 'bug-1' }] }, {}, deps,
    );
    expect(result.targetsUpdated).toBe(0);
    expect(writes).toEqual([]);
  });

  it('updates supplied inverse display metadata in place while retaining known unsupplied data', async () => {
    const source = { itemId: 'plan-1', direction: 'out', trackerType: 'plan', title: 'Before', issueKey: 'NIM-1', relationshipTypeKey: 'blocks', metadata: { note: 'retain' } };
    const other = { itemId: 'plan-2', direction: 'out', trackerType: 'plan', relationshipTypeKey: 'blocks' };
    const { writes, deps } = makeDeps([{ id: 'bug-1', type: 'bug', data: { blockedBy: [source, other] } }]);
    await propagateInverseRelationships(
      { id: 'plan-1', type: 'plan', title: 'After' },
      { dependsOn: [{ itemId: 'bug-1' }] }, {}, deps,
    );
    expect(writes).toHaveLength(1);
    expect(writes[0].value).toEqual([{ ...source, title: 'After' }, other]);
  });

  describe('composite type fields', () => {
    it('materializes a secondary source field into a secondary target field', async () => {
      globalRegistry.register(model('plain-source', [{ name: 'title', type: 'string' }]));
      globalRegistry.register(model('plain-target', [{ name: 'title', type: 'string' }]));
      const { writes, deps } = makeDeps([{
        id: 'target-1', type: 'plain-target', typeTags: ['plain-target', 'bug'],
        data: { customFields: { blockedBy: [{ itemId: 'older-source', relationshipTypeKey: 'blocks' }] } },
      }]);
      const result = await propagateInverseRelationships(
        { id: 'source-1', type: 'plain-source', typeTags: ['plain-source', 'plan', 'plan'] },
        { dependsOn: [{ itemId: 'target-1' }] }, {}, deps,
      );
      expect(result.targetsUpdated).toBe(1);
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({ itemId: 'target-1', fieldName: 'blockedBy' });
      expect((writes[0].value as Array<{ itemId: string }>).map(value => value.itemId)).toEqual(['older-source', 'source-1']);
    });

    it('removes secondary-field links using the target actual type tags', async () => {
      globalRegistry.register(model('plain-source', [{ name: 'title', type: 'string' }]));
      globalRegistry.register(model('plain-target', [{ name: 'title', type: 'string' }]));
      const { writes, deps } = makeDeps([{
        id: 'target-1', type: 'plain-target', typeTags: ['bug'],
        data: { blockedBy: [{ itemId: 'source-1' }, { itemId: 'older-source' }] },
      }]);
      await propagateInverseRelationships(
        { id: 'source-1', type: 'plain-source', typeTags: ['plan'] },
        { dependsOn: [] }, { dependsOn: [{ itemId: 'target-1' }] }, deps,
      );
      expect(writes).toHaveLength(1);
      expect((writes[0].value as Array<{ itemId: string }>).map(value => value.itemId)).toEqual(['older-source']);
    });

    it('preserves primary field precedence on both sides even if tags omit or reorder it', async () => {
      globalRegistry.register(model('plain-source', [{ name: 'dependsOn', type: 'string' }]));
      globalRegistry.register(model('plain-target', [{ name: 'blockedBy', type: 'string' }]));
      const { writes, deps } = makeDeps([{ id: 'target-1', type: 'plain-target', typeTags: ['bug'], data: {} }]);
      await propagateInverseRelationships(
        { id: 'source-1', type: 'plain-source', typeTags: ['plan'] },
        { dependsOn: [{ itemId: 'target-1' }] }, {}, deps,
      );
      expect(writes).toEqual([]);
      await propagateInverseRelationships(
        { id: 'source-1', type: 'plan', typeTags: ['plain-source', 'plan'] },
        { dependsOn: [{ itemId: 'target-1' }] }, {}, deps,
      );
      // Target's primary scalar wins over the secondary relationship field.
      expect(writes).toEqual([]);
    });

    it('uses one workspace-scoped schema resolver for source and target', async () => {
      const source = model('scoped-source', PLAN.fields);
      const target = model('scoped-target', BUG.fields);
      globalRegistry.register(model(source.type, []));
      globalRegistry.register(model(target.type, []));
      const local = new Map([[source.type, source], [target.type, target]]);
      const { writes, deps } = makeDeps([{ id: 'target-1', type: target.type, data: {} }]);
      await propagateInverseRelationships(
        { id: 'source-1', type: source.type },
        { dependsOn: [{ itemId: 'target-1' }] }, {},
        { ...deps, getModel: type => local.get(type) },
      );
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({ itemId: 'target-1', fieldName: 'blockedBy' });
    });
  });

  /**
   * NIM-1305: synced items store relationship arrays NESTED under
   * `data.customFields.<field>`, not at the top level. The inverse read MUST be
   * customFields-aware, or adding one link reads the target's existing inverse as
   * empty and overwrites (clobbers) the other links. These fixtures mirror the
   * real synced storage shape (verified against NIM-985 / NIM-1332 in the DB).
   */
  describe('customFields-nested storage (synced items)', () => {
    it('preserves a target\'s existing inverse links (nested) when adding one', async () => {
      // bug-1 already blocks plan-9 and plan-8; its inverse array lives nested.
      const { writes, deps } = makeDeps([
        { id: 'bug-1', type: 'bug', data: { customFields: { blockedBy: [
          { itemId: 'plan-9', relationshipTypeKey: 'blocks' },
          { itemId: 'plan-8', relationshipTypeKey: 'blocks' },
        ] } } },
      ]);
      await propagateInverseRelationships(
        { id: 'plan-1', type: 'plan', issueKey: 'NIM-1', title: 'Plan One' },
        { dependsOn: [{ itemId: 'bug-1' }] },
        {}, // source had no prior dependsOn
        deps,
      );
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({ itemId: 'bug-1', fieldName: 'blockedBy' });
      const ids = (writes[0].value as Array<{ itemId: string }>).map((v) => v.itemId).sort();
      // Must keep plan-9 + plan-8 AND add plan-1 — not clobber down to [plan-1].
      expect(ids).toEqual(['plan-1', 'plan-8', 'plan-9']);
    });

    it('removes only the dropped link from a target\'s nested inverse array', async () => {
      const { writes, deps } = makeDeps([
        { id: 'bug-1', type: 'bug', data: { customFields: { blockedBy: [
          { itemId: 'plan-1', relationshipTypeKey: 'blocks' },
          { itemId: 'plan-8', relationshipTypeKey: 'blocks' },
        ] } } },
      ]);
      await propagateInverseRelationships(
        { id: 'plan-1', type: 'plan' },
        { dependsOn: [] }, // dropped bug-1
        { dependsOn: [{ itemId: 'bug-1' }] },
        deps,
      );
      expect(writes).toHaveLength(1);
      const ids = (writes[0].value as Array<{ itemId: string }>).map((v) => v.itemId);
      // plan-1 removed, plan-8 preserved.
      expect(ids).toEqual(['plan-8']);
    });

    it('diffs the source\'s prior value from nested customFields (no false re-add)', async () => {
      // Source plan-1 already depends on bug-1 (nested); the update re-asserts the
      // same value. With a nested-aware prev read, the diff is empty → no write.
      const { writes, deps } = makeDeps([
        { id: 'bug-1', type: 'bug', data: { customFields: { blockedBy: [{ itemId: 'plan-1', relationshipTypeKey: 'blocks' }] } } },
      ]);
      await propagateInverseRelationships(
        { id: 'plan-1', type: 'plan' },
        { dependsOn: [{ itemId: 'bug-1' }] },
        { customFields: { dependsOn: [{ itemId: 'bug-1' }] } }, // prior value nested
        deps,
      );
      expect(writes).toHaveLength(0);
    });
  });
});
