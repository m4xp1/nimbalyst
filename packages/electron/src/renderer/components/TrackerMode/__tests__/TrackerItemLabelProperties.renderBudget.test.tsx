// @vitest-environment jsdom
/**
 * Render budget for the label-driven part of the tracker detail pane.
 *
 * Claim-stored property values are derived from the whole tracker map, which
 * changes on every edit to any item. The section must subscribe to the claims
 * about ITS item only, and label resolution must be memoized on the item's
 * labels, or every keystroke anywhere in the tracker repaints the open detail.
 */

// MUST be the first import: it installs the DevTools hook shim that the render
// profiler reads, and react-dom captures that hook once at module init.
import { measureRenders } from '../../../devtools/renderBudget';

import React from 'react';
import { Provider, createStore } from 'jotai';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyLabelRegistry, globalRegistry } from '@nimbalyst/tracker-schema';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import { trackerItemsMapAtom } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerDataAtoms';
import {
  resolveTrackerLabelFields,
  useTrackerLabelFields,
  type TrackerLabelFieldLayout,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/components/trackerLabelFields';
import { TrackerItemLabelProperties } from '../TrackerItemLabelProperties';

vi.mock('../../../services/ErrorNotificationService', () => ({
  errorNotificationService: { showError: vi.fn() },
}));

function record(id: string, primaryType: string, fields: Record<string, unknown>, updatedAt = '2026-09-01T00:00:00Z'): TrackerRecord {
  return {
    id,
    primaryType,
    typeTags: [primaryType],
    source: 'native',
    archived: false,
    syncStatus: 'local',
    system: { workspace: '/ws', createdAt: updatedAt, updatedAt },
    fields,
  } as TrackerRecord;
}

function installVocabulary() {
  // Only a type with a `label-ref` field carries labels.
  globalRegistry.register({
    type: 'entity',
    displayName: 'Entity',
    displayNamePlural: 'Entities',
    icon: 'category',
    color: '#000000',
    modes: { inline: true, fullDocument: true },
    idPrefix: 'ent',
    idFormat: 'ulid',
    fields: [{ name: 'title', type: 'string', required: true }, { name: 'labels', type: 'label-ref', multiValue: true }],
  });
  globalRegistry.setPredicates([
    { id: 'annual-revenue', label: 'Revenue', subjectKinds: ['*'], valueShape: 'text', direction: 'directed' },
  ]);
  globalRegistry.setLabels({
    labels: [{ id: 'organization', label: 'Organization', properties: ['annual-revenue'] }],
    properties: [],
    claimProperties: {},
  });
}

afterEach(() => {
  cleanup();
  globalRegistry.setLabels(emptyLabelRegistry());
  globalRegistry.setPredicates([]);
});

describe('tracker detail label properties render budget', () => {
  it('repaints claim values only when a claim about this item changes', async () => {
    installVocabulary();
    const subject = record('ent-1', 'entity', { title: 'Acme', labels: ['organization'] });
    const claim = (valueText: string, updatedAt: string) => record('clm-1', 'claim', {
      subject: { itemId: 'ent-1' },
      predicate: 'annual-revenue',
      valueText,
      qualifiers: { asOf: '2026-08-01' },
      status: 'asserted',
    }, updatedAt);
    const other = (title: string) => record('task-1', 'task', { title });

    const store = createStore();
    store.set(trackerItemsMapAtom, new Map([
      ['ent-1', subject],
      ['clm-1', claim('$10M', '2026-09-01T00:00:00Z')],
      ['task-1', other('Unrelated')],
    ]));
    const layout = resolveTrackerLabelFields('entity', subject.fields);
    const values = subject.fields;
    const noop = () => {};

    render(
      <Provider store={store}>
        <TrackerItemLabelProperties item={subject} layout={layout} values={values} editable onSaveField={noop} />
      </Provider>,
    );
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByTestId('tracker-claim-property-annual-revenue').textContent).toContain('$10M');

    const unrelated = await measureRenders(async () => {
      await act(async () => {
        const next = new Map(store.get(trackerItemsMapAtom));
        next.set('task-1', other('Renamed'));
        store.set(trackerItemsMapAtom, next);
      });
    });
    expect(unrelated.rendersOf('TrackerClaimPropertyValues'), unrelated.report()).toBe(0);

    const related = await measureRenders(async () => {
      await act(async () => {
        const next = new Map(store.get(trackerItemsMapAtom));
        next.set('clm-1', claim('$12M', '2026-09-02T00:00:00Z'));
        store.set(trackerItemsMapAtom, next);
      });
    });
    expect(related.rendersOf('TrackerClaimPropertyValues'), related.report()).toBe(1);
    expect(screen.getByTestId('tracker-claim-property-annual-revenue').textContent).toContain('$12M');
  });

  it('keeps the resolved label layout while the item changes in ways that do not touch its labels', () => {
    installVocabulary();
    const seen: TrackerLabelFieldLayout[] = [];
    function Probe({ values }: { values: Record<string, unknown> }) {
      seen.push(useTrackerLabelFields('entity', values));
      return null;
    }
    const { rerender } = render(<Probe values={{ title: 'Acme', labels: ['organization'] }} />);
    rerender(<Probe values={{ title: 'Acme Corp', labels: ['organization'] }} />);
    expect(seen[1]).toBe(seen[0]);
    rerender(<Probe values={{ title: 'Acme Corp', labels: [] }} />);
    expect(seen[2]).not.toBe(seen[0]);
    expect(seen[2].claims).toEqual([]);
  });
});
