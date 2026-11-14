import { afterEach, describe, expect, it, vi } from 'vitest';
import { store } from '@nimbalyst/runtime/store';
import { markSessionReadAtom, markSessionsReadAtom, refreshSessionListAtom, sessionListWorkspaceAtom, sessionUnreadAtom } from '../sessions';

describe('markSessionsReadAtom', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('clears unread for every session once, even when an id repeats', () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('window', { electronAPI: { invoke } });

    const parent = 'mark-all-read-parent';
    const children = ['mark-all-read-child-1', 'mark-all-read-child-2'];
    for (const id of [parent, ...children]) {
      store.set(sessionUnreadAtom(id), true);
    }

    store.set(markSessionsReadAtom, [parent, ...children, parent]);

    for (const id of [parent, ...children]) {
      expect(store.get(sessionUnreadAtom(id))).toBe(false);
    }
    const persisted = invoke.mock.calls
      .filter(([channel]) => channel === 'ai:updateSessionMetadata')
      .map(([, sessionId]) => sessionId);
    expect(persisted).toEqual([parent, ...children]);
  });

  it('does not restore an old unread snapshot after the session was read locally', async () => {
    const id = 'read-before-list-snapshot';
    const oldTime = Date.now() - 1000;
    const invoke = vi.fn(async (channel: string) => channel === 'sessions:list' ? {
      success: true, sessions: [{ id, createdAt: oldTime, updatedAt: oldTime, hasUnread: true }],
    } : { success: true });
    vi.stubGlobal('window', { electronAPI: { invoke } });
    store.set(sessionListWorkspaceAtom, '/synthetic/unread');
    store.set(markSessionReadAtom, id);
    await store.set(refreshSessionListAtom);
    expect(store.get(sessionUnreadAtom(id))).toBe(false);
    store.set(sessionListWorkspaceAtom, null);
  });
});
