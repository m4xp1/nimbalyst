// @vitest-environment jsdom
import React, { useContext } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Provider, type Atom, type PrimitiveAtom } from 'jotai';
import type { LexicalEditor } from 'lexical';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatAnnotation } from '@nimbalyst/runtime/ai/chatAnnotations';
import { store } from '@nimbalyst/runtime/store';
import { sessionStoreAtom } from '../../../store/atoms/sessions';
import { DraftAnnotationList, FileAnnotationMarkers, TranscriptAnnotationControls, useFileAnnotationAction } from '../ChatAnnotationControls';
import {
  AnnotationSessionContext, AnnotationSessionProvider, acceptChatAnnotationSubmission, applyChatAnnotationSnapshot, chatAnnotationDraftAtom,
  consumeChatAnnotationDraft, flushAllChatAnnotationDrafts, flushChatAnnotationDraft, trackChatAnnotationSubmission, updateChatAnnotationDraft,
} from '../chatAnnotationDraft';
import { getTextSelection, setTextSelection } from '../TextSelectionIndicator';
import { AnnotationEditorProvider } from '../AnnotationEditorProvider';

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

const { positionReference } = vi.hoisted(() => ({ positionReference: vi.fn() }));
vi.mock('@floating-ui/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@floating-ui/react')>();
  const refs = { setFloating: () => {}, setPositionReference: positionReference, floating: { current: null } };
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
  positionReference.mockClear();
  invoke.mockReset().mockResolvedValue({ success: true });
  vi.stubGlobal('electronAPI', { invoke });
});

afterEach(async () => {
  window.getSelection()?.removeAllRanges();
  cleanup();
  await flushAllChatAnnotationDrafts();
  vi.unstubAllGlobals();
});

describe('chat annotation draft persistence', () => {
  it('finds a file marker from the separate draft root and reopens its editor', async () => {
    const click = (button: HTMLElement) => {
      fireEvent.pointerDown(button);
      act(() => button.focus());
      fireEvent.pointerUp(button);
      fireEvent.click(button);
    };
    const sessionId = 'annotation-find-separate-root';
    const paragraph = document.createElement('p');
    paragraph.textContent = 'Before the selected words after.';
    paragraph.scrollIntoView = vi.fn();
    const rect = new DOMRect(20, 200, 400, 25);
    vi.spyOn(paragraph, 'getClientRects').mockReturnValue(Object.assign([rect], { item: () => rect }));
    document.body.append(paragraph);
    const editor = { registerRootListener: (listener: (root: HTMLElement) => void) => { listener(paragraph); return () => {}; } } as LexicalEditor;
    hydrate(sessionId, [makeAnnotation('Find this note')]);
    try {
      render(<Provider store={store}><AnnotationSessionProvider value={sessionId}><FileAnnotationHarness editor={editor} filePath="/workspace/notes.md" /></AnnotationSessionProvider></Provider>);
      const visibleDraft = render(<Provider store={store}><DraftAnnotationList sessionId={sessionId} navigate={() => {}} /></Provider>);
      // Agent and Files are kept mounted; the hidden view must not handle the visible editor's clicks.
      render(<Provider store={store}><div style={{ display: 'none' }}><DraftAnnotationList sessionId={sessionId} navigate={() => {}} /></div></Provider>);
      const ui = within(visibleDraft.container);
      click(ui.getByText('1 annotation'));
      click(ui.getByRole('button', { name: '1. the selected words' }));
      click(ui.getByRole('button', { name: 'Find annotation source' }));
      await waitFor(() => expect(paragraph.scrollIntoView).toHaveBeenCalled());
      expect((await screen.findByRole<HTMLTextAreaElement>('textbox', { name: 'Annotation comment' })).value).toBe('Find this note');
    } finally { paragraph.remove(); }
  });
  it('clears annotations when the user message is persisted while the agent is still running', async () => {
    const sessionId = 'annotation-accepted-message';
    const sent = makeAnnotation('Sent note');
    hydrate(sessionId, [sent]);
    const release = trackChatAnnotationSubmission(sessionId, [sent]);
    acceptChatAnnotationSubmission(sessionId);
    expect(store.get(chatAnnotationDraftAtom(sessionId))).toEqual([]);
    await flushChatAnnotationDraft(sessionId);
    release();
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it('flushes the last keystroke once and does not write it again after the timer', async () => {
    vi.useFakeTimers();
    try {
      const sessionId = 'annotation-flush';
      hydrate(sessionId, [makeAnnotation('Saved')]);
      updateChatAnnotationDraft(sessionId, draft => draft.map(annotation => ({ ...annotation, comment: 'Last keystroke' })));
      await flushChatAnnotationDraft(sessionId);
      await vi.advanceTimersByTimeAsync(1000);
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke.mock.calls[0][2]).toEqual({ metadata: { draftAnnotations: [makeAnnotation('Last keystroke')] }, annotationDraftBase: [makeAnnotation('Saved')] });
    } finally {
      vi.useRealTimers();
    }
  });

  it('merges another window snapshot while preserving an unsaved local comment', async () => {
    const sessionId = 'annotation-concurrent-window';
    hydrate(sessionId, [makeAnnotation('Saved')]);
    updateChatAnnotationDraft(sessionId, draft => draft.map(annotation => ({ ...annotation, comment: 'Local edit' })));
    const other = { ...makeAnnotation('Other window'), id: 'annotation-2' };
    applyChatAnnotationSnapshot(sessionId, [makeAnnotation('Saved'), other]);
    expect(store.get(chatAnnotationDraftAtom(sessionId))).toEqual([makeAnnotation('Local edit'), other]);
    await flushChatAnnotationDraft(sessionId);
    expect(invoke.mock.calls[0][2]).toMatchObject({ metadata: { draftAnnotations: [makeAnnotation('Local edit'), other] } });
  });

  it('clears the sent snapshot but keeps comments changed while sending', async () => {
    const sessionId = 'annotation-sent-snapshot';
    const sent = makeAnnotation('Sent version');
    hydrate(sessionId, [sent]);
    updateChatAnnotationDraft(sessionId, draft => draft.map(annotation => ({ ...annotation, comment: 'Next draft' })));
    await consumeChatAnnotationDraft(sessionId, [sent]);
    expect(store.get(chatAnnotationDraftAtom(sessionId))).toEqual([makeAnnotation('Next draft')]);
    await consumeChatAnnotationDraft(sessionId, [makeAnnotation('Next draft')]);
    expect(store.get(chatAnnotationDraftAtom(sessionId))).toEqual([]);
  });
  it('updates all views immediately and saves one snapshot after typing stops', async () => {
    vi.useFakeTimers();
    try {
      const sessionId = 'annotation-debounced-input';
      hydrate(sessionId, [makeAnnotation('Initial')]);
      for (const comment of ['O', 'On', 'One final note']) {
        updateChatAnnotationDraft(sessionId, draft => draft.map(annotation => ({ ...annotation, comment })));
        await vi.advanceTimersByTimeAsync(50);
      }
      expect(store.get(chatAnnotationDraftAtom(sessionId))[0].comment).toBe('One final note');
      expect(invoke).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(300);
      expect(invoke).toHaveBeenCalledExactlyOnceWith('sessions:update-metadata', sessionId, {
        metadata: { draftAnnotations: [makeAnnotation('One final note')] },
        annotationDraftBase: [makeAnnotation('Initial')],
      });
    } finally {
      vi.useRealTimers();
    }
  });
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
    expect(invoke.mock.calls.filter(([, id]) => id === firstSession)).toEqual([
      ['sessions:update-metadata', firstSession, { metadata: { draftAnnotations: [makeAnnotation('First edit')] }, annotationDraftBase: expect.any(Array) }],
      ['sessions:update-metadata', firstSession, { metadata: { draftAnnotations: [makeAnnotation('Latest edit')] }, annotationDraftBase: expect.any(Array) }],
    ]);
    expect(invoke.mock.calls.filter(([, id]) => id === secondSession)).toEqual([
      ['sessions:update-metadata', secondSession, { metadata: { draftAnnotations: [makeAnnotation('Separate draft')] }, annotationDraftBase: [] }],
    ]);
    hydrate(firstSession, [makeAnnotation('Reloaded draft')]);
    expect(store.get(chatAnnotationDraftAtom(firstSession))[0].comment).toBe('Reloaded draft');
  });
});

describe('adding and editing chat annotations', () => {
  it.each([false, true])('anchors a multiline transcript selection at its focus and adds the exact quote (backward=%s)', backward => {
    vi.stubGlobal('CSS', { escape: (value: string) => value });
    const sessionId = `annotation-focus-${backward}`;
    const root = document.createElement('section');
    const paragraph = document.createElement('p');
    paragraph.dataset.annotationMessageId = 'multiline-message';
    paragraph.textContent = 'First line\nSecond line';
    root.append(paragraph); document.body.append(root);
    const savedRect = Object.getOwnPropertyDescriptor(Range.prototype, 'getBoundingClientRect');
    const savedRects = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects');
    const first = new DOMRect(10, 20, 200, 20), last = new DOMRect(10, 50, 80, 20);
    Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [first, last] });
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: function (this: Range) {
      return this.collapsed ? new DOMRect(this.startOffset === 0 ? 10 : 90, this.startOffset === 0 ? 20 : 50, 0, 20) : new DOMRect(10, 20, 200, 50);
    } });
    try {
      render(<Provider store={store}><TranscriptAnnotationControls sessionId={sessionId} root={root} /></Provider>);
      window.getSelection()!.setBaseAndExtent(paragraph.firstChild!, backward ? paragraph.textContent.length : 0, paragraph.firstChild!, backward ? 0 : paragraph.textContent.length);
      fireEvent(document, new Event('selectionchange'));
      const reference = positionReference.mock.calls.at(-1)![0];
      const rect = reference.getBoundingClientRect();
      expect({ x: rect.x, y: rect.y, width: rect.width }).toEqual({ x: backward ? 10 : 90, y: backward ? 20 : 50, width: 0 });
      fireEvent.click(screen.getByRole('button', { name: 'Add to chat' }));
      expect(store.get(chatAnnotationDraftAtom(sessionId))).toEqual([expect.objectContaining({ quote: 'First line\nSecond line', source: { type: 'message', sessionId, messageId: 'multiline-message' } })]);
    } finally {
      if (savedRect) Object.defineProperty(Range.prototype, 'getBoundingClientRect', savedRect); else delete (Range.prototype as any).getBoundingClientRect;
      if (savedRects) Object.defineProperty(Range.prototype, 'getClientRects', savedRects); else delete (Range.prototype as any).getClientRects;
      root.remove();
    }
  });
  it('receives the active session across a separate editor root and switches without remounting', () => {
    let target: Atom<string | null> | null = null;
    function CaptureScope() { target = useContext(AnnotationSessionContext); return null; }
    const parent = render(<Provider store={store}><AnnotationSessionProvider value="root-session-a">
      <CaptureScope />
    </AnnotationSessionProvider></Provider>);
    const paragraph = document.createElement('p');
    paragraph.textContent = 'Before the selected words after.';
    document.body.append(paragraph);
    const editor = { registerRootListener: (listener: (root: HTMLElement) => void) => {
      listener(paragraph);
      return () => {};
    } } as LexicalEditor;
    render(<AnnotationEditorProvider target={target}><FileAnnotationHarness editor={editor} filePath="/workspace/root.md" /></AnnotationEditorProvider>);
    const add = () => {
      const range = document.createRange();
      range.setStart(paragraph.firstChild!, 7);
      range.setEnd(paragraph.firstChild!, 25);
      window.getSelection()!.addRange(range);
      fireEvent.click(screen.getByRole('button', { name: 'Add to chat' }));
    };
    try {
      add();
      parent.rerender(<Provider store={store}><AnnotationSessionProvider value="root-session-b"><CaptureScope /></AnnotationSessionProvider></Provider>);
      add();
      expect(store.get(chatAnnotationDraftAtom('root-session-a'))).toHaveLength(1);
      expect(store.get(chatAnnotationDraftAtom('root-session-b'))).toHaveLength(1);
    } finally {
      paragraph.remove();
    }
  });
  it('opens a draft editor without navigation and provides an explicit Find action', () => {
    const sessionId = 'annotation-find-action';
    const annotation = makeAnnotation('A note');
    hydrate(sessionId, [annotation]);
    const navigate = vi.fn();
    render(<Provider store={store}><DraftAnnotationList sessionId={sessionId} navigate={navigate} /></Provider>);
    fireEvent.click(screen.getByText('1 annotation'));
    fireEvent.click(screen.getByRole('button', { name: '1. the selected words' }));
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Annotation comment in draft' }).value).toBe('A note');
    fireEvent.click(screen.getByRole('button', { name: 'Find annotation source' }));
    expect(navigate).toHaveBeenCalledExactlyOnceWith(annotation);
  });

  it('replaces the matching Selection when adding a file annotation', () => {
    const sessionId = 'annotation-replaces-selection';
    const paragraph = document.createElement('p');
    paragraph.textContent = 'Before the selected words after.';
    const editor = { registerRootListener: (listener: (root: HTMLElement) => void) => {
      listener(paragraph);
      return () => {};
    } } as LexicalEditor;
    document.body.append(paragraph);
    try {
      render(<Provider store={store}><AnnotationSessionProvider value={sessionId}>
        <FileAnnotationHarness editor={editor} filePath="/workspace/notes.md" />
      </AnnotationSessionProvider></Provider>);
      setTextSelection('the selected words', '/workspace/notes.md');
      const range = document.createRange();
      range.setStart(paragraph.firstChild!, 7);
      range.setEnd(paragraph.firstChild!, 25);
      window.getSelection()!.addRange(range);
      fireEvent.click(screen.getByRole('button', { name: 'Add to chat' }));
      expect(getTextSelection()).toBeNull();
      expect(store.get(chatAnnotationDraftAtom(sessionId))).toEqual([
        expect.objectContaining({ quote: 'the selected words' }),
      ]);
    } finally {
      paragraph.remove();
    }
  });
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
        <AnnotationSessionProvider value={sessionId}>
          <FileAnnotationHarness editor={editor} filePath={filePath} />
        </AnnotationSessionProvider>
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
      fireEvent.pointerDown(document.body);
      await waitFor(() => expect(invoke).toHaveBeenLastCalledWith('sessions:update-metadata', firstSession, {
        annotationDraftBase: expect.any(Array),
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
      const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 60 });
      fireEvent(root, wheel);
      expect(wheel.defaultPrevented).toBe(false);
      expect(screen.queryByRole('textbox', { name: 'Annotation comment' })).toBeNull();
      await waitFor(() => expect(invoke).toHaveBeenLastCalledWith('sessions:update-metadata', sessionId, {
        annotationDraftBase: expect.any(Array),
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
    expect(navigate).not.toHaveBeenCalled();
    const editor = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Annotation comment in draft' });
    expect(editor.value).toBe('Retained note');
    fireEvent.change(editor, { target: { value: '' } });
    fireEvent.blur(editor, { relatedTarget: document.body });
    expect(screen.queryByText('1 annotation')).toBeNull();
    await waitFor(() => expect(invoke).toHaveBeenLastCalledWith('sessions:update-metadata', sessionId, {
      metadata: { draftAnnotations: [] },
      annotationDraftBase: expect.any(Array),
    }));
  });
});
