import { createContext } from 'react';
import { atom } from 'jotai';
import { atomFamily } from '../../store/debug/atomFamilyRegistry';
import { readChatAnnotations, type ChatAnnotation } from '@nimbalyst/runtime/ai/chatAnnotations';
import { store } from '@nimbalyst/runtime/store';
import { sessionStoreAtom, updateSessionStoreAtom } from '../../store/atoms/sessions';
import { errorNotificationService } from '../../services/ErrorNotificationService';

export const AnnotationSessionContext = createContext<string | null>(null);

const pendingDraft = atomFamily((_sessionId: string) => atom<ChatAnnotation[] | undefined>(undefined));
export const chatAnnotationDraftAtom = atomFamily((sessionId: string) => atom(get =>
  get(pendingDraft(sessionId)) ?? readChatAnnotations(get(sessionStoreAtom(sessionId))?.metadata?.draftAnnotations),
));
export const openChatAnnotationAtom = atomFamily((_sessionId: string) => atom<string | null>(null));

const saves = new Map<string, Promise<void>>();

export function updateChatAnnotationDraft(sessionId: string, update: (draft: ChatAnnotation[]) => ChatAnnotation[]): void {
  const previous = store.get(chatAnnotationDraftAtom(sessionId));
  const next = update(previous);
  if (previous === next) return;
  store.set(pendingDraft(sessionId), next);
  const save = (saves.get(sessionId) ?? Promise.resolve()).then(async () => {
    if (store.get(pendingDraft(sessionId)) !== next) return;
    const result = await window.electronAPI.invoke('sessions:update-metadata', sessionId, {
      metadata: { draftAnnotations: next },
    });
    if (!result?.success) throw new Error(result?.error ?? 'Unable to save annotation draft.');
    const session = store.get(sessionStoreAtom(sessionId));
    if (session && store.get(pendingDraft(sessionId)) === next) {
      store.set(updateSessionStoreAtom, { sessionId, updates: { metadata: { ...session.metadata, draftAnnotations: next } } });
      store.set(pendingDraft(sessionId), undefined);
    }
  }).catch(error => {
    errorNotificationService.showError('Could not save annotations', String(error));
  });
  saves.set(sessionId, save);
  void save.then(() => {
    if (saves.get(sessionId) === save) saves.delete(sessionId);
  });
}
