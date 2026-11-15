import { atom } from 'jotai';
import { atomFamily } from '../../store/debug/atomFamilyRegistry';
import { store } from '@nimbalyst/runtime/store';
import { readMessageDraftContext, type MessageDraftContext } from '@nimbalyst/runtime/ai/messageClipboard';
import { sessionStoreAtom, updateSessionStoreAtom } from '../../store/atoms/sessions';
import { errorNotificationService } from '../../services/ErrorNotificationService';

const pending = atomFamily((_sessionId: string) => atom<MessageDraftContext | null | undefined>(undefined));
const saved = atomFamily((_sessionId: string) => atom<MessageDraftContext | null>(null));
export const messageDraftContextAtom = atomFamily((sessionId: string) => atom(get => {
  const local = get(pending(sessionId));
  if (local !== undefined) return local;
  const metadata = get(sessionStoreAtom(sessionId))?.metadata;
  return metadata && Object.hasOwn(metadata, 'draftMessageContext')
    ? readMessageDraftContext(metadata.draftMessageContext) ?? null : get(saved(sessionId));
}));

export function applyMessageDraftContextSnapshot(sessionId: string, value: unknown): void {
  const context = readMessageDraftContext(value) ?? null;
  store.set(saved(sessionId), context);
  const session = store.get(sessionStoreAtom(sessionId));
  if (session) store.set(updateSessionStoreAtom, { sessionId, updates: { metadata: { ...session.metadata, draftMessageContext: context } } });
}

const writes = new Map<string, Promise<void>>();
/** Context changes are discrete paste/remove/undo operations, not keystrokes. */
export function setMessageDraftContext(sessionId: string, context: MessageDraftContext | null): void {
  store.set(pending(sessionId), context);
  const write = (writes.get(sessionId) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const result = await window.electronAPI.invoke('sessions:update-metadata', sessionId, { metadata: { draftMessageContext: context } });
    if (!result?.success) throw new Error(result?.error ?? 'Unable to save pasted context');
    if (store.get(pending(sessionId)) === context) {
      applyMessageDraftContextSnapshot(sessionId, context);
      store.set(pending(sessionId), undefined);
    }
  });
  writes.set(sessionId, write);
  void write.then(() => { if (writes.get(sessionId) === write) writes.delete(sessionId); }, error => {
    errorNotificationService.showError('Could not save pasted context', String(error));
  });
}

export function consumeMessageDraftContext(sessionId: string, snapshot: MessageDraftContext | null): void {
  if (snapshot && JSON.stringify(store.get(messageDraftContextAtom(sessionId))) === JSON.stringify(snapshot)) setMessageDraftContext(sessionId, null);
}
