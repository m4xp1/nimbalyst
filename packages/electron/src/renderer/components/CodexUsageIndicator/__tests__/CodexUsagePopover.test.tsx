// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { codexUsageAtom, codexWorkspaceAtom } from '../../../store/atoms/codexUsageAtoms';
import { CodexUsagePopover } from '../CodexUsagePopover';

vi.mock('../../../store/atoms/appSettings', async () => ({ toggleGutterItemHiddenAtom: (await import('jotai')).atom(null, () => {}) }));
vi.mock('../../../store/listeners/codexUsageListeners', () => ({ refreshCodexWorkspace: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../UsageHistory/WeeklyUsageHistory', () => ({ WeeklyUsageHistory: () => null }));
vi.mock('@nimbalyst/runtime/ui/icons/MaterialSymbol', () => ({ MaterialSymbol: () => <span aria-hidden="true" /> }));
vi.mock('../../../hooks/useFloatingMenu', () => ({
  FloatingPortal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useFloatingMenu: () => ({ refs: { setReference: () => {}, setFloating: () => {} }, floatingStyles: {}, getFloatingProps: () => ({}) }),
}));

const invoke = vi.fn();
const pending = {
  independent: true, authenticated: true, canSwitch: true, email: 'current@example.test', selectedId: 'work',
  signingIn: true, signInHintVisible: true,
  choices: [{ id: 'work', name: 'Work' }, { id: 'personal', name: 'Personal' }],
};
const store = createStore();
function openPanel() {
  return render(<Provider store={store}><CodexUsagePopover anchorRef={{ current: null }} onClose={() => {}} onRefresh={async () => {}} /></Provider>);
}
beforeEach(() => {
  invoke.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { invoke } });
  store.set(codexUsageAtom, { limits: [], lastUpdated: Date.now() });
  store.set(codexWorkspaceAtom, pending);
});
afterEach(cleanup);

it('allows selecting a workspace and restarting sign-in while the browser is pending', async () => {
  openPanel();
  expect(screen.getByRole('status')).toHaveTextContent('Complete sign-in in your browser.');
  expect(screen.getByRole('combobox', { name: 'Workspace' })).toBeEnabled();
  fireEvent.change(screen.getByRole('combobox', { name: 'Workspace' }), { target: { value: 'personal' } });
  await waitFor(() => expect(screen.getByRole('combobox', { name: 'Workspace' })).toBeEnabled());
  expect(invoke).toHaveBeenCalledWith('codex-workspace:select', 'personal');
  fireEvent.click(screen.getByRole('link', { name: 'current@example.test' }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('codex-workspace:sign-in', undefined));
});

it('hides the shared timed-out hint in every open view and keeps it hidden on reopen', () => {
  const first = openPanel();
  const second = openPanel();
  expect(screen.getAllByRole('status')).toHaveLength(2);
  act(() => store.set(codexWorkspaceAtom, { ...pending, signInHintVisible: false }));
  expect(screen.queryByRole('status')).toBeNull();
  first.unmount(); second.unmount(); openPanel();
  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.getByRole('combobox', { name: 'Workspace' })).toBeEnabled();
  expect(screen.getByRole('link', { name: 'current@example.test' })).toBeVisible();
});

it('removes the hint as soon as the completed account snapshot arrives', () => {
  openPanel();
  act(() => store.set(codexWorkspaceAtom, { ...pending, signingIn: false, signInHintVisible: false, email: 'new@example.test', selectedId: 'personal' }));
  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.getByRole('link', { name: 'new@example.test' })).toBeVisible();
  expect(screen.getByRole('combobox', { name: 'Workspace' })).toHaveValue('personal');
});
