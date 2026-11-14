// @vitest-environment jsdom
/**
 * Regression coverage for the usage-indicator rail restore bug: "Disable" in
 * the Claude/Codex/Gemini usage popovers used to write the standalone
 * `ai.show*UsageIndicator` setting, which has no restore affordance anywhere
 * in the UI. Every rail-side restore surface (right-click "Show X",
 * "Customize Gutter…", "Show All") reads `hiddenGutterItemsAtom` instead, so
 * a disabled indicator was a dead end. "Disable" must hide the item through
 * the same gutter-customization atom the restore UI reads.
 */
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { Provider, createStore } from 'jotai';

import { hiddenGutterItemsAtom } from '../../../store/atoms/appSettings';
import { canHideGutterItem, type GutterItemMeta } from '../navGutterItems';

// Bypass @floating-ui/react positioning entirely -- these tests only care
// about what the "Disable" button writes, not popover placement, and
// FloatingPortal's layout effects don't have anything meaningful to attach
// to in jsdom without a real anchor element in the viewport.
vi.mock('../../../hooks/useFloatingMenu', () => ({
  useFloatingMenu: () => ({
    refs: { setFloating: () => {}, setReference: () => {} },
    floatingStyles: {},
    getFloatingProps: () => ({}),
  }),
  FloatingPortal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@nimbalyst/runtime', () => ({
  MaterialSymbol: () => null,
  ProviderIcon: () => null,
}));

import { claudeUsageAtom } from '../../../store/atoms/claudeUsageAtoms';
import { codexUsageAtom, codexWorkspaceAtom } from '../../../store/atoms/codexUsageAtoms';
vi.mock('../../../store/listeners/codexUsageListeners', () => ({ refreshCodexWorkspace: vi.fn(async () => null) }));
import { geminiUsageAtom } from '../../../store/atoms/geminiUsageAtoms';
import { ClaudeUsagePopover } from '../../ClaudeUsageIndicator/ClaudeUsagePopover';
import { CodexUsagePopover } from '../../CodexUsageIndicator/CodexUsagePopover';
import { GeminiUsagePopover } from '../../GeminiUsageIndicator/GeminiUsagePopover';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function noopRef() {
  return { current: null } as React.RefObject<HTMLElement | null>;
}

describe('usage popover "Disable" hides via the gutter customization atom', () => {
  it('shows model percent used including unused limits without duplicating legacy Opus', () => {
    const store = createStore();
    store.set(claudeUsageAtom, {
      fiveHour: { utilization: 55, resetsAt: null },
      sevenDay: { utilization: 73, resetsAt: null },
      sevenDayOpus: { utilization: 10, resetsAt: null },
      weeklyModelLimits: [
        { model: 'Fable', utilization: 86, resetsAt: null },
        { model: 'Opus', utilization: 0, resetsAt: null },
      ],
      lastUpdated: Date.now(),
    });
    const { getByText, getAllByText } = render(
      <Provider store={store}>
        <ClaudeUsagePopover anchorRef={noopRef()} onClose={() => {}} onRefresh={async () => {}} />
      </Provider>,
    );
    getByText('86%');
    getByText('0%');
    expect(getAllByText('Opus (Weekly)')).toHaveLength(1);
  });

  it('ClaudeUsagePopover Disable adds claude-usage to hiddenGutterItemsAtom', () => {
    const store = createStore();
    store.set(claudeUsageAtom, {
      fiveHour: { utilization: 10, resetsAt: null },
      sevenDay: { utilization: 10, resetsAt: null },
      lastUpdated: Date.now(),
    });

    const { getByText } = render(
      <Provider store={store}>
        <ClaudeUsagePopover anchorRef={noopRef()} onClose={() => {}} onRefresh={async () => {}} />
      </Provider>,
    );

    expect(store.get(hiddenGutterItemsAtom)).not.toContain('claude-usage');
    fireEvent.click(getByText('Disable'));
    expect(store.get(hiddenGutterItemsAtom)).toContain('claude-usage');
  });

  it('CodexUsagePopover Disable adds codex-usage to hiddenGutterItemsAtom', () => {
    const store = createStore();
    // Codex usage now uses the duration-window shape (see codexUsageAtoms).
    // The Disable button renders regardless of limits, so an empty window
    // list is enough to mount the popover far enough to click it.
    store.set(codexUsageAtom, {
      limits: [],
      lastUpdated: Date.now(),
    });

    const { getByText } = render(
      <Provider store={store}>
        <CodexUsagePopover anchorRef={noopRef()} onClose={() => {}} onRefresh={async () => {}} />
      </Provider>,
    );

    expect(store.get(hiddenGutterItemsAtom)).not.toContain('codex-usage');
    fireEvent.click(getByText('Disable'));
    expect(store.get(hiddenGutterItemsAtom)).toContain('codex-usage');
  });

  it('shows the cached account immediately and chooses a workspace through the Codex broker', async () => {
    const invoke = vi.fn(async () => undefined);
    vi.stubGlobal('electronAPI', { ...window.electronAPI, invoke });
    const store = createStore();
    store.set(codexWorkspaceAtom, {
      independent: true,
      authenticated: true, email: 'account@example.test', canSwitch: true,
      selectedId: 'test-personal',
      choices: [{ id: 'test-personal', name: 'Personal' }, { id: 'test-team', name: 'Team' }],
      signingIn: false,
    });
    store.set(codexUsageAtom, { limits: [], lastUpdated: Date.now() });
    const { findByRole, getByRole } = render(
      <Provider store={store}>
        <CodexUsagePopover anchorRef={noopRef()} onClose={() => {}} onRefresh={async () => {}} />
      </Provider>,
    );
    const picker = await findByRole('combobox', { name: 'Workspace' }) as HTMLSelectElement;
    expect(picker.value).toBe('test-personal');
    expect(invoke).not.toHaveBeenCalled();
    fireEvent.change(picker, { target: { value: 'test-team' } });
    expect(invoke).toHaveBeenCalledWith('codex-workspace:select', 'test-team');
    const account = getByRole('link', { name: 'account@example.test' }) as HTMLButtonElement;
    await waitFor(() => expect(account.disabled).toBe(false));
    fireEvent.click(account);
    expect(invoke).toHaveBeenCalledWith('codex-workspace:sign-in', undefined);
    await waitFor(() => expect(account.disabled).toBe(false));
  });

  it('keeps Sign in available without authentication and hides an unknown or single workspace', () => {
    const store = createStore();
    store.set(codexUsageAtom, { limits: [], limitsAvailable: false, lastUpdated: Date.now() });
    const view = render(<Provider store={store}><CodexUsagePopover anchorRef={noopRef()} onClose={() => {}} onRefresh={async () => {}} /></Provider>);
    view.getByRole('link', { name: 'Sign in' });
    expect(view.queryByRole('combobox')).toBeNull();
    React.act(() => store.set(codexWorkspaceAtom, {
      independent: false, authenticated: true, email: null, canSwitch: false,
      selectedId: 'only', choices: [{ id: 'only', name: 'Personal' }], signingIn: false,
    }));
    view.getByRole('link', { name: 'ChatGPT Desktop' });
    expect(view.queryByRole('combobox')).toBeNull();
    React.act(() => store.set(codexWorkspaceAtom, {
      independent: false, authenticated: true, email: 'desktop@example.test', canSwitch: false,
      selectedId: 'only', choices: [{ id: 'only', name: 'Personal' }, { id: 'team', name: 'Team' }], signingIn: false,
    }));
    expect((view.getByRole('combobox') as HTMLSelectElement).disabled).toBe(true);
    view.getByRole('link', { name: 'desktop@example.test' });
  });

  it('GeminiUsagePopover Disable adds gemini-usage to hiddenGutterItemsAtom', () => {
    const store = createStore();
    store.set(geminiUsageAtom, {
      fiveHour: { utilization: 10, resetsAt: null },
      sevenDay: { utilization: 10, resetsAt: null },
      lastUpdated: Date.now(),
    });

    const { getByText } = render(
      <Provider store={store}>
        <GeminiUsagePopover anchorRef={noopRef()} onClose={() => {}} onRefresh={async () => {}} />
      </Provider>,
    );

    expect(store.get(hiddenGutterItemsAtom)).not.toContain('gemini-usage');
    fireEvent.click(getByText('Disable'));
    expect(store.get(hiddenGutterItemsAtom)).toContain('gemini-usage');
  });
});

// Characterization coverage (already correct pre-fix; these don't flip
// red->green) for the restore-menu filter the fix now has a path to
// exercise: an id present in hiddenGutterItemsAtom is offered as "Show X"
// only if it's still in the live registry.
describe('GutterContextMenu restorableHidden filter (canHideGutterItem / registry membership)', () => {
  const registry: GutterItemMeta[] = [
    { id: 'claude-usage', section: 'indicators', icon: 'speed', label: 'Claude Usage', hideable: true },
    { id: 'codex-usage', section: 'indicators', icon: 'speed', label: 'Codex Usage', hideable: true },
  ];

  function restorableHidden(hiddenIds: string[], items: GutterItemMeta[]): string[] {
    return hiddenIds.filter((id) => items.some((it) => it.id === id));
  }

  it('offers to restore a hidden item that is still in the registry', () => {
    expect(restorableHidden(['claude-usage'], registry)).toEqual(['claude-usage']);
  });

  it('does not offer to restore an id no longer present in the registry (e.g. uninstalled extension panel)', () => {
    expect(restorableHidden(['gemini-usage'], registry)).toEqual([]);
  });

  it('canHideGutterItem allows hiding a non-mode indicator regardless of other hidden items', () => {
    const meta = registry[0];
    expect(canHideGutterItem('claude-usage', meta, [], [])).toBe(true);
  });
});
