// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Provider, type PrimitiveAtom } from 'jotai';
import type { LexicalEditor } from 'lexical';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatAnnotation } from '@nimbalyst/runtime/ai/chatAnnotations';
import { store } from '@nimbalyst/runtime/store';
import { sessionStoreAtom } from '../../../store/atoms/sessions';
import { DraftAnnotationList, FileAnnotationMarkers, TranscriptAnnotationControls, useFileAnnotationAction } from '../ChatAnnotationControls';
import { AnnotationSessionContext, chatAnnotationDraftAtom, updateChatAnnotationDraft } from '../chatAnnotationDraft';

vi.mock('../../../store/atoms/sessions', async () => {
  const { atom } = await import('jotai');
  type TestSession = { metadata?: { draftAnnotations?: ChatAnnotation[] } };
  const atoms = new Map<string, PrimitiveAtom<TestSession>>();
  const sessionStoreAtom = (id: string) => {
    let existing = atoms.get(id);
    if (!existing) {
      existing = atom<TestSession>({});
      atoms.set(id, existing);
    }
    return existing;
  };
  return {
    sessionStoreAtom,
    updateSessionStoreAtom: atom(null, (_get, set, { sessionId, updates }: { sessionId: string; updates: TestSession }) => {
      set(sessionStoreAtom(sessionId), session => ({ ...session, ...updates }));
    }),
  };
});

vi.mock('@floating-ui/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@floating-ui/react')>();
  const refs = { setFloating: () => {}, setPositionReference: () => {} };
  return {
    ...actual,
    FloatingPortal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useFloating: () => ({ refs, floatingStyles: {} }),
  };
});

const makeAnnotation = (comment: string): ChatAnnotation => ({
  id: 'annotation-1',
  source: { type: 'file', filePath: '/workspace/notes.md' },
  quote: 'the selected words',
  before: '',
  after: '',
  comment,
});

function hydrate(sessionId: string, annotations: ChatAnnotation[]) {
  store.set(sessionStoreAtom(sessionId), { metadata: { draftAnnotations: annotations } } as never);
}

function FileAnnotationHarness({ editor, filePath }: { editor: LexicalEditor; filePath: string }) {
  const { actions, sessionId, root } = useFileAnnotationAction(filePath, editor, true);
  return (
    <>
      {actions.map(action => (
        <button key={action.id} onClick={action.onSelect}>{action.label}</button>
      ))}
      {sessionId && root && <FileAnnotationMarkers sessionId={sessionId} root={root} filePath={filePath} />}
    </>
  );
}

const invoke = vi.fn();
beforeEach(() => {
  invoke.mockReset().mockResolvedValue({ success: true });
  vi.stubGlobal('electronAPI', { invoke });
});

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  cleanup();
  vi.unstubAllGlobals();
});

describe('chat annotation draft persistence', () => {
  it('loads annotations for the selected session, then persists rapid edits in order', async () => {
    const firstSession = 'annotation-draft-a';
    const secondSession = 'annotation-draft-b';
    const saved = makeAnnotation('On disk');
    hydrate(firstSession, [saved]);
    expect(store.get(chatAnnotationDraftAtom(firstSession))).toEqual([saved]);
    expect(store.get(chatAnnotationDraftAtom(secondSession))).toEqual([]);

    let resolveFirst!: (value: { success: boolean }) => void;
    invoke.mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }));
    const updateComment = (id: string, comment: string) =>
      updateChatAnnotationDraft(id, draft => draft.map(annotation => ({ ...annotation, comment })));
    updateComment(firstSession, 'First edit');
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    updateComment(firstSession, 'Middle edit');
    updateComment(firstSession, 'Latest edit');
    updateChatAnnotationDraft(secondSession, () => [makeAnnotation('Separate draft')]);
    expect(store.get(chatAnnotationDraftAtom(firstSession))[0].comment).toBe('Latest edit');
    expect(store.get(chatAnnotationDraftAtom(secondSession))[0].comment).toBe('Separate draft');

    await act(async () => { resolveFirst({ success: true }); });
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(3));
    expect(invoke.mock.calls).toEqual([
      ['sessions:update-metadata', firstSession, { metadata: { draftAnnotations: [makeAnnotation('First edit')] } }],
      ['sessions:update-metadata', secondSession, { metadata: { draftAnnotations: [makeAnnotation('Separate draft')] } }],
      ['sessions:update-metadata', firstSession, { metadata: { draftAnnotations: [makeAnnotation('Latest edit')] } }],
    ]);
    hydrate(firstSession, [makeAnnotation('Reloaded draft')]);
    expect(store.get(chatAnnotationDraftAtom(firstSession))[0].comment).toBe('Reloaded draft');
  });
});

describe('adding and editing chat annotations', () => {
  it('switches the markers and their draft when the same file stays open', async () => {
    const firstSession = 'annotation-first-file-chat';
    const secondSession = 'annotation-second-file-chat';
    const filePath = '/workspace/notes.md';
    const paragraph = document.createElement('p');
    paragraph.textContent = 'Before the selected words after.';
    paragraph.scrollIntoView = vi.fn();
    const rect = new DOMRect();
    vi.spyOn(paragraph, 'getClientRects').mockReturnValue(Object.assign([rect], { item: () => rect }));
    const editor = {
      registerRootListener: (listener: (root: HTMLElement) => void) => {
        listener(paragraph);
        return () => {};
      },
    } as LexicalEditor;
    const view = (sessionId: string) => (
      <Provider store={store}>
        <AnnotationSessionContext.Provider value={sessionId}>
          <FileAnnotationHarness editor={editor} filePath={filePath} />
        </AnnotationSessionContext.Provider>
      </Provider>
    );
    document.body.append(paragraph);
    try {
      const { rerender } = render(view(firstSession));
      const range = document.createRange();
      range.setStart(paragraph.firstChild!, 7);
      range.setEnd(paragraph.firstChild!, 25);
      window.getSelection()!.addRange(range);
      fireEvent.click(screen.getByRole('button', { name: 'Add to chat' }));
      const comment = screen.getByRole('textbox', { name: 'Annotation comment' });
      fireEvent.change(comment, { target: { value: 'First draft only' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save annotation' }));
      await waitFor(() => expect(invoke).toHaveBeenLastCalledWith('sessions:update-metadata', firstSession, {
        metadata: { draftAnnotations: [expect.objectContaining({
          source: { type: 'file', filePath },
          quote: 'the selected words',
          comment: 'First draft only',
        })] },
      }));

      rerender(view(secondSession));
      expect(screen.queryByRole('button', { name: 'Edit annotation 1' })).toBeNull();
      expect(store.get(chatAnnotationDraftAtom(secondSession))).toEqual([]);

      rerender(view(firstSession));
      fireEvent.click(screen.getByRole('button', { name: 'Edit annotation 1' }));
      const reopened = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Annotation comment' });
      expect(reopened.value).toBe('First draft only');
      expect(paragraph.textContent).toBe('Before the selected words after.');
    } finally {
      paragraph.remove();
    }
  });

  it('adds selected transcript text to the current session and keeps a typed comment on Escape', async () => {
    vi.stubGlobal('CSS', { escape: (value: string) => value });
    const sessionId = 'annotation-add-transcript';
    const root = document.createElement('section');
    const paragraph = document.createElement('p');
    paragraph.dataset.annotationMessageId = 'message-1';
    paragraph.textContent = 'Before the selected words after.';
    paragraph.scrollIntoView = vi.fn();
    const rect = new DOMRect();
    vi.spyOn(paragraph, 'getClientRects').mockReturnValue(Object.assign([rect], { item: () => rect }));
    root.append(paragraph);
    document.body.append(root);
    try {
      render(<Provider store={store}><TranscriptAnnotationControls sessionId={sessionId} root={root} /></Provider>);
      const selection = window.getSelection()!;
      const range = document.createRange();
      range.setStart(paragraph.firstChild!, 7);
      range.setEnd(paragraph.firstChild!, 25);
      selection.addRange(range);
      fireEvent(document, new Event('selectionchange'));
      fireEvent.click(screen.getByRole('button', { name: 'Add to chat' }));
      const editor = await screen.findByRole('textbox', { name: 'Annotation comment' });
      fireEvent.change(editor, { target: { value: 'Keep this note' } });
      fireEvent.keyDown(editor, { key: 'Escape' });
      expect(screen.queryByRole('textbox', { name: 'Annotation comment' })).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: 'Edit annotation 1' }));
      const reopened = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Annotation comment' });
      expect(reopened.value).toBe('Keep this note');
      await waitFor(() => expect(invoke).toHaveBeenLastCalledWith('sessions:update-metadata', sessionId, {
        metadata: { draftAnnotations: [expect.objectContaining({
          source: { type: 'message', sessionId, messageId: 'message-1' },
          quote: 'the selected words',
          comment: 'Keep this note',
        })] },
      }));
    } finally {
      root.remove();
    }
  });

  it('lets the user navigate and edit a retained quote even when its source is absent', async () => {
    const sessionId = 'annotation-detached-source';
    const annotation = makeAnnotation('Retained note');
    hydrate(sessionId, [annotation]);
    const navigate = vi.fn();
    render(<Provider store={store}><DraftAnnotationList sessionId={sessionId} navigate={navigate} /></Provider>);
    fireEvent.click(screen.getByText('1 annotation'));
    fireEvent.click(screen.getByRole('button', { name: '1. the selected words' }));
    expect(navigate).toHaveBeenCalledExactlyOnceWith(annotation);
    const editor = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Annotation comment in draft' });
    expect(editor.value).toBe('Retained note');
    fireEvent.change(editor, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.queryByText('1 annotation')).toBeNull();
    await waitFor(() => expect(invoke).toHaveBeenLastCalledWith('sessions:update-metadata', sessionId, {
      metadata: { draftAnnotations: [] },
    }));
  });
});
