// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { store } from '@nimbalyst/runtime/store';
import { applyMessageDraftContextSnapshot, consumeMessageDraftContext, messageDraftContextAtom, setMessageDraftContext } from '../messageDraftContext';

describe('pasted draft context', () => {
  it('accepts metadata broadcasts without a mounted session and keeps a local edit while its older save finishes', async () => {
    let finish!: (result: unknown) => void;
    const invoke = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue({ success: true });
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { invoke } });
    const id = 'pasted-metadata-race';
    const first = { document: { filePath: 'first.md' } }, second = { document: { filePath: 'second.md' } };
    setMessageDraftContext(id, first);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    setMessageDraftContext(id, second);
    applyMessageDraftContextSnapshot(id, first);
    expect(store.get(messageDraftContextAtom(id))).toEqual(second);
    finish({ success: true });
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(store.get(messageDraftContextAtom(id))).toEqual(second));
  });

  it('clears only the submitted snapshot, preserving a newer paste during an active send', async () => {
    const invoke = vi.fn().mockResolvedValue({ success: true });
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { invoke } });
    const id = 'pasted-context-consumption';
    const sent = { document: { filePath: 'sent.md' } }, next = { document: { filePath: 'next.md' } };
    applyMessageDraftContextSnapshot(id, next);
    consumeMessageDraftContext(id, sent);
    expect(store.get(messageDraftContextAtom(id))).toEqual(next);
    consumeMessageDraftContext(id, next);
    expect(store.get(messageDraftContextAtom(id))).toBeNull();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('sessions:update-metadata', id, { metadata: { draftMessageContext: null } }));
  });
});
