// @vitest-environment node

/**
 * `tracker_define_type({ predicates, labels })` merges by id. It used to
 * replace the whole predicate registry, so two agents extending the vocabulary
 * at once erased each other's verbs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('electron', async () => ({
  app: {
    getPath: (await import('../../../../../test-stubs/privateUserData')).testApp.getPath,
    getName: vi.fn(() => 'test-app'),
    getVersion: vi.fn(() => '1.0.0'),
    on: vi.fn(),
  },
}));

vi.mock('../../../services/TrackerSchemaService', () => ({
  applyWorkspacePredicateRegistryInProcess: vi.fn(),
  applyWorkspaceLabelRegistryInProcess: vi.fn(),
}));

import type { PredicateDefinition } from '@nimbalyst/tracker-schema';
import { applyLabelRegistryArgs, applyPredicateRegistryArgs } from '../trackerVocabularyArgs';
import { readWorkspacePredicateRegistry } from '../../../services/tracker/trackerPredicateRegistryFile';
import { readWorkspaceLabelRegistry } from '../../../services/tracker/trackerLabelRegistryFile';

const verb = (id: string): PredicateDefinition => ({
  id, label: id, subjectKinds: ['*'], valueShape: 'entity', direction: 'directed',
});

describe('tracker_define_type vocabulary arguments', () => {
  let workspacePath: string;
  beforeEach(() => { workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-vocab-')); });
  afterEach(() => { fs.rmSync(workspacePath, { recursive: true, force: true }); });

  it('merges predicates by id and only removes one when asked and confirmed', async () => {
    await applyPredicateRegistryArgs(workspacePath, { predicates: [verb('made-by')] });
    await applyPredicateRegistryArgs(workspacePath, { predicates: [verb('in-market')] });
    expect(readWorkspacePredicateRegistry(workspacePath)?.map(p => p.id)).toEqual(['made-by', 'in-market']);

    const refused = await applyPredicateRegistryArgs(workspacePath, { removePredicates: ['made-by'] });
    expect('error' in refused).toBe(true);
    await applyPredicateRegistryArgs(workspacePath, { removePredicates: ['made-by'], confirmDestructive: true });
    expect(readWorkspacePredicateRegistry(workspacePath)?.map(p => p.id)).toEqual(['in-market']);
  });

  it('merges labels by id, checks them against predicates, and gates a removed label property', async () => {
    await applyLabelRegistryArgs(workspacePath, {
      labels: { labels: [{ id: 'capability', label: 'Capability', properties: ['owner'] }], properties: [{ id: 'owner', label: 'Owner', type: 'string' }] },
    }, [verb('implemented-in')]);
    const added = await applyLabelRegistryArgs(workspacePath, {
      labels: { labels: [{ id: 'feature', label: 'Feature', broader: ['capability'], properties: ['implemented-in'] }] },
    }, [verb('implemented-in')]);
    expect('error' in added).toBe(false);
    expect(readWorkspaceLabelRegistry(workspacePath)?.labels.map(l => l.id)).toEqual(['capability', 'feature']);

    const clash = await applyLabelRegistryArgs(workspacePath, {
      labels: { properties: [{ id: 'implemented-in', label: 'Clash', type: 'string' }] },
    }, [verb('implemented-in')]);
    expect('error' in clash && JSON.stringify(clash.error)).toContain('LABEL_PROPERTY_ID_CONFLICT');

    const shrink = { labels: { labels: [{ id: 'capability', label: 'Capability', properties: [] }] } };
    expect('error' in await applyLabelRegistryArgs(workspacePath, shrink, [verb('implemented-in')])).toBe(true);
    await applyLabelRegistryArgs(workspacePath, { ...shrink, confirmDestructive: true }, [verb('implemented-in')]);
    expect(readWorkspaceLabelRegistry(workspacePath)?.labels[0].properties).toEqual([]);
  });

  it('persists presentation-only edits without asking for confirmation', async () => {
    await applyPredicateRegistryArgs(workspacePath, { predicates: [verb('made-by')] });
    await applyPredicateRegistryArgs(workspacePath, { predicates: [{ ...verb('made-by'), label: 'is made by' }] });
    expect(readWorkspacePredicateRegistry(workspacePath)?.[0].label).toBe('is made by');

    await applyLabelRegistryArgs(workspacePath, { labels: { labels: [{ id: 'feature', label: 'Feature' }] } }, []);
    const renamed = { id: 'feature', label: 'Product feature', description: 'Shipped behavior', role: 'page', template: '## Why', factBox: [] };
    const result = await applyLabelRegistryArgs(workspacePath, { labels: { labels: [renamed] } }, []);
    expect('error' in result).toBe(false);
    expect(readWorkspaceLabelRegistry(workspacePath)?.labels).toEqual([renamed]);
  });
});
