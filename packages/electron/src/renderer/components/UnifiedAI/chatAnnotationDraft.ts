import { createContext, createElement, useLayoutEffect, useMemo, type ReactNode } from 'react';
import { atom, type Atom } from 'jotai';
import { atomFamily } from '../../store/debug/atomFamilyRegistry';
import { mergeChatAnnotationChanges, readChatAnnotations, sameChatAnnotation, type ChatAnnotation } from '@nimbalyst/runtime/ai/chatAnnotations';
import { store } from '@nimbalyst/runtime/store';
import { sessionStoreAtom, updateSessionStoreAtom } from '../../store/atoms/sessions';
import { errorNotificationService } from '../../services/ErrorNotificationService';

export const AnnotationSessionContext = createContext<Atom<string | null> | null>(null);

/** The stable atom crosses TabContent's separate React roots without remounting editors. */
export function AnnotationSessionProvider({ value, children }: { value: string | null; children: ReactNode }) {
  const target = useMemo(() => atom(value), []);
  useLayoutEffect(() => { store.set(target, value); }, [target, value]);
  return createElement(AnnotationSessionContext.Provider, { value: target }, children);
}

interface PendingDraft {
  base: ChatAnnotation[];
  annotations: ChatAnnotation[];
}

const pendingDraft = atomFamily((_sessionId: string) => atom<PendingDraft | undefined>(undefined));
const savedDraft = atomFamily((_sessionId: string) => atom<ChatAnnotation[] | undefined>(undefined));
const remoteDraft = atomFamily((sessionId: string) => atom(get => {
  const metadata = get(sessionStoreAtom(sessionId))?.metadata;
  return metadata?.draftAnnotations !== undefined
    ? readChatAnnotations(metadata.draftAnnotations)
    : get(savedDraft(sessionId)) ?? [];
}));

function mergeDraft(remote: ChatAnnotation[], pending: PendingDraft): ChatAnnotation[] {
  return mergeChatAnnotationChanges(remote, pending.base, pending.annotations);
}

export const chatAnnotationDraftAtom = atomFamily((sessionId: string) => atom(get => {
  const remote = get(remoteDraft(sessionId));
  const pending = get(pendingDraft(sessionId));
  return pending ? mergeDraft(remote, pending) : remote;
}));
export const openChatAnnotationAtom = atomFamily((_sessionId: string) => atom<string | null>(null));
export const editDraftAnnotationAtom = atomFamily((_sessionId: string) => atom<string | null>(null));
export const revealChatAnnotationAtom = atomFamily((_sessionId: string) => atom<string | null>(null));

const saves = new Map<string, Promise<void>>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const dirtySessions = new Set<string>();
const remoteVersions = new Map<string, number>();
const submissions = new Map<string, readonly ChatAnnotation[]>();
export const ANNOTATION_SAVE_DELAY_MS = 300;

/** Called by the existing session metadata listener, including for unloaded sessions. */
export function applyChatAnnotationSnapshot(sessionId: string, value: unknown): void {
  const annotations = readChatAnnotations(value);
  store.set(savedDraft(sessionId), annotations);
  remoteVersions.set(sessionId, (remoteVersions.get(sessionId) ?? 0) + 1);
  const session = store.get(sessionStoreAtom(sessionId));
  if (session) {
    store.set(updateSessionStoreAtom, { sessionId, updates: { metadata: { ...session.metadata, draftAnnotations: annotations } } });
  }
}

function reportSaveError(error: unknown): void {
  errorNotificationService.showError('Could not save annotations', String(error));
}

export function flushChatAnnotationDraft(sessionId: string): Promise<void> {
  const timer = timers.get(sessionId);
  if (timer) clearTimeout(timer);
  timers.delete(sessionId);
  const previousSave = saves.get(sessionId) ?? Promise.resolve();
  const save = previousSave.catch(() => {}).then(async () => {
    const pending = store.get(pendingDraft(sessionId));
    if (!pending) return;
    const annotations = store.get(chatAnnotationDraftAtom(sessionId));
    const remoteVersion = remoteVersions.get(sessionId);
    const result = await window.electronAPI.invoke('sessions:update-metadata', sessionId, {
      metadata: { draftAnnotations: annotations },
      annotationDraftBase: pending.base,
    });
    if (!result?.success) throw new Error(result?.error ?? 'Unable to save annotation draft.');
    // A newer broadcast may already include changes from another window.
    if (remoteVersions.get(sessionId) === remoteVersion) applyChatAnnotationSnapshot(sessionId, result.draftAnnotations ?? annotations);
    if (store.get(pendingDraft(sessionId)) === pending) {
      store.set(pendingDraft(sessionId), undefined);
      dirtySessions.delete(sessionId);
    }
  });
  saves.set(sessionId, save);
  void save.then(() => {
    if (saves.get(sessionId) === save) saves.delete(sessionId);
  }, error => {
    if (saves.get(sessionId) === save) saves.delete(sessionId);
    reportSaveError(error);
  });
  return save;
}

export function hasPendingChatAnnotationDrafts(): boolean {
  return dirtySessions.size > 0 || saves.size > 0;
}

export async function flushAllChatAnnotationDrafts(): Promise<void> {
  await Promise.all([...new Set([...dirtySessions, ...saves.keys()])].map(flushChatAnnotationDraft));
}

export function consumeChatAnnotationDraft(sessionId: string, sent: readonly ChatAnnotation[]): Promise<void> {
  const snapshot = new Map(sent.map(annotation => [annotation.id, annotation]));
  updateChatAnnotationDraft(sessionId, draft => draft.filter(annotation => !sameChatAnnotation(snapshot.get(annotation.id), annotation)));
  return flushChatAnnotationDraft(sessionId);
}

export function trackChatAnnotationSubmission(sessionId: string, annotations: readonly ChatAnnotation[]): () => void {
  submissions.set(sessionId, annotations);
  return () => { if (submissions.get(sessionId) === annotations) submissions.delete(sessionId); };
}

/** A persisted user message acknowledges the send before a long agent turn finishes. */
export function acceptChatAnnotationSubmission(sessionId: string): void {
  const annotations = submissions.get(sessionId);
  if (!annotations) return;
  submissions.delete(sessionId);
  if (annotations.length) void consumeChatAnnotationDraft(sessionId, annotations).catch(() => {});
}

export function updateChatAnnotationDraft(sessionId: string, update: (draft: ChatAnnotation[]) => ChatAnnotation[]): void {
  const previous = store.get(chatAnnotationDraftAtom(sessionId));
  const next = update(previous);
  if (previous === next || (previous.length === next.length && previous.every((annotation, index) => sameChatAnnotation(annotation, next[index])))) return;
  store.set(pendingDraft(sessionId), { base: store.get(remoteDraft(sessionId)), annotations: next });
  dirtySessions.add(sessionId);
  const previousTimer = timers.get(sessionId);
  if (previousTimer) clearTimeout(previousTimer);
  timers.set(sessionId, setTimeout(() => { void flushChatAnnotationDraft(sessionId).catch(() => {}); }, ANNOTATION_SAVE_DELAY_MS));
}
