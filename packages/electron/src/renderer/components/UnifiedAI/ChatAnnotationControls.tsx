import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { atom, useAtom, useAtomValue } from 'jotai';
import { FloatingPortal, autoUpdate, flip, hide, offset, shift, useFloating } from '@floating-ui/react';
import type { LexicalEditor } from 'lexical';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import {
  chatAnnotationSourceLabel, findChatAnnotationOffset,
  type ChatAnnotation, type ChatAnnotationSource,
} from '@nimbalyst/runtime/ai/chatAnnotations';
import type { FloatingTextToolbarAction } from '@nimbalyst/runtime/editor/plugins/FloatingTextFormatToolbarPlugin/types';
import {
  AnnotationSessionContext, chatAnnotationDraftAtom, editDraftAnnotationAtom, flushChatAnnotationDraft,
  openChatAnnotationAtom, revealChatAnnotationAtom, updateChatAnnotationDraft,
} from './chatAnnotationDraft';
import { clearTextSelection, getTextSelectionForFile, selectionPathsMatch } from './TextSelectionIndicator';

type SelectionAnchor = Pick<ChatAnnotation, 'quote' | 'before' | 'after'>;
const noAnnotationSession = atom<string | null>(null);

function selectionAnchor(root: HTMLElement, range: Range): SelectionAnchor | null {
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const quote = range.toString();
  if (!quote.trim()) return null;
  const textBefore = range.cloneRange();
  textBefore.selectNodeContents(root);
  textBefore.setEnd(range.startContainer, range.startOffset);
  const text = root.textContent ?? '';
  const start = textBefore.toString().length;
  return { quote, before: text.slice(Math.max(0, start - 48), start), after: text.slice(start + quote.length, start + quote.length + 48) };
}

function restoreRange(root: HTMLElement, annotation: ChatAnnotation): Range | null {
  const start = findChatAnnotationOffset(root.textContent ?? '', annotation);
  if (start === null) return null;
  const end = start + annotation.quote.length;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let index = 0;
  let foundStart = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const boundary = index + (node.textContent?.length ?? 0);
    if (!foundStart && start < boundary) {
      range.setStart(node, start - index);
      foundStart = true;
    }
    if (foundStart && end <= boundary) {
      range.setEnd(node, end - index);
      return range;
    }
    index = boundary;
  }
  return null;
}

function addAnnotation(
  sessionId: string,
  source: ChatAnnotationSource,
  anchor: SelectionAnchor,
  open: (id: string) => void,
) {
  const id = crypto.randomUUID();
  updateChatAnnotationDraft(sessionId, previous => [...previous, { id, source, ...anchor, comment: '' }]);
  if (source.type === 'file' && getTextSelectionForFile(source.filePath)?.text === anchor.quote) {
    clearTextSelection(source.filePath);
  }
  window.getSelection()?.removeAllRanges();
  open(id);
}

export function useFileAnnotationAction(filePath: string, editor: LexicalEditor | null, active: boolean) {
  const target = useContext(AnnotationSessionContext);
  const sessionId = useAtomValue(target ?? noAnnotationSession);
  const [, openAnnotation] = useAtom(openChatAnnotationAtom(sessionId ?? ''));
  const [root, setRoot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!active || !editor || typeof editor.registerRootListener !== 'function') {
      setRoot(null);
      return;
    }
    return editor.registerRootListener(setRoot);
  }, [active, editor]);

  const actions = useMemo<FloatingTextToolbarAction[]>(() => !sessionId || !root ? [] : [{
    id: 'add-selection-to-chat',
    label: 'Add to chat',
    icon: <MaterialSymbol icon="chat_bubble" size={16} />,
    availableWhenReadOnly: true,
    onSelect: () => {
      const selection = window.getSelection();
      if (!selection?.rangeCount) return;
      const anchor = selectionAnchor(root, selection.getRangeAt(0));
      if (anchor) addAnnotation(sessionId, { type: 'file', filePath }, anchor, openAnnotation);
    },
  }], [sessionId, root, filePath, openAnnotation]);
  return { actions, sessionId, root };
}

function AnnotationMarker({ sessionId, annotation, range, boundary, index, isOpen, setOpen }: {
  sessionId: string;
  annotation: ChatAnnotation;
  range: Range;
  boundary: HTMLElement;
  index: number;
  isOpen: boolean;
  setOpen: (id: string | null) => void;
}) {
  const { refs, floatingStyles, middlewareData } = useFloating({
    placement: 'top-end',
    strategy: 'fixed',
    middleware: [offset(3), flip({ boundary, padding: 6 }), shift({ boundary, padding: 6, crossAxis: true }), hide({ boundary })],
    whileElementsMounted: autoUpdate,
  });
  useEffect(() => {
    refs.setPositionReference({
      getBoundingClientRect: () => range.getBoundingClientRect(),
      contextElement: range.commonAncestorContainer.parentElement ?? undefined,
    });
  }, [refs, range]);
  const finish = useCallback(() => {
    // Read the shared draft so closing in the same event loop keeps the last keystroke.
    updateChatAnnotationDraft(sessionId, draft => draft.filter(a => a.id !== annotation.id || a.comment.trim()));
    void flushChatAnnotationDraft(sessionId).catch(() => {});
    setOpen(null);
  }, [sessionId, annotation.id, setOpen]);
  useEffect(() => {
    if (!isOpen) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !refs.floating.current?.contains(event.target)) finish();
    };
    const scroll = (event: Event) => {
      if (!(event.target instanceof Node) || !refs.floating.current?.contains(event.target)) finish();
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('wheel', scroll, { capture: true, passive: true });
    document.addEventListener('scroll', scroll, { capture: true, passive: true });
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('wheel', scroll, true);
      document.removeEventListener('scroll', scroll, true);
    };
  }, [isOpen, finish, refs]);
  return (
    <FloatingPortal>
      <div ref={refs.setFloating} style={{ ...floatingStyles, visibility: middlewareData?.hide?.referenceHidden ? 'hidden' : undefined }}
        className="chat-annotation-marker z-50 flex flex-col items-end gap-1">
        {isOpen && (
          <form className="flex items-start gap-1 rounded-lg border border-nim bg-nim-secondary p-2 shadow-md" onSubmit={event => {
            event.preventDefault();
            finish();
          }} onKeyDown={event => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              finish();
            }
          }}>
            <textarea
              aria-label="Annotation comment"
              autoFocus
              rows={2}
              value={annotation.comment}
              onChange={event => {
                const comment = event.currentTarget.value;
                updateChatAnnotationDraft(sessionId, draft => draft.map(a => a.id === annotation.id ? { ...a, comment } : a));
              }}
              className="w-56 max-h-40 resize-y rounded border border-nim bg-nim p-1 text-nim"
            />
          </form>
        )}
        <button type="button" onClick={() => { if (isOpen) finish(); else setOpen(annotation.id); }}
          aria-label={`Edit annotation ${index}`} className="rounded-full bg-nim-primary px-1.5 text-xs text-white shadow">
          {index}
        </button>
      </div>
    </FloatingPortal>
  );
}

export function ChatAnnotationMarkers({ sessionId, root, sourceRoot }: {
  sessionId: string;
  root: HTMLElement;
  sourceRoot: (source: ChatAnnotationSource) => HTMLElement | null;
}) {
  const [draft] = useAtom(chatAnnotationDraftAtom(sessionId));
  const [open, setOpen] = useAtom(openChatAnnotationAtom(sessionId));
  const [reveal, setReveal] = useAtom(revealChatAnnotationAtom(sessionId));
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let frame = 0;
    const observer = new MutationObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setRevision(value => value + 1));
    });
    observer.observe(root, { subtree: true, childList: true, characterData: true });
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => setRevision(value => value + 1));
    resize?.observe(root);
    return () => { observer.disconnect(); resize?.disconnect(); cancelAnimationFrame(frame); };
  }, [root]);
  const markers = useMemo(() => draft.flatMap((annotation, index) => {
    const owner = sourceRoot(annotation.source);
    const range = owner?.getClientRects().length ? restoreRange(owner, annotation) : null;
    return range ? [{ annotation, index: index + 1, range }] : [];
  }), [draft, sourceRoot, revision]);
  useEffect(() => {
    if (!reveal) return;
    const marker = markers.find(item => item.annotation.id === reveal);
    if (!marker) return;
    marker.range.startContainer.parentElement?.scrollIntoView({ block: 'center' });
    const frame = requestAnimationFrame(() => {
      setOpen(reveal);
      setReveal(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [reveal, markers, setOpen, setReveal]);
  const boundary = root.closest<HTMLElement>('.tab-editor-wrapper') ?? root;
  return markers.map(({ annotation, index, range }) => (
    <AnnotationMarker key={annotation.id} sessionId={sessionId} annotation={annotation} range={range} boundary={boundary}
      index={index} isOpen={open === annotation.id} setOpen={setOpen} />
  ));
}

export function FileAnnotationMarkers({ sessionId, root, filePath }: {
  sessionId: string; root: HTMLElement; filePath: string;
}) {
  const sourceRoot = useCallback((source: ChatAnnotationSource) =>
    source.type === 'file' && selectionPathsMatch(source.filePath, filePath) ? root : null, [root, filePath]);
  return <ChatAnnotationMarkers sessionId={sessionId} root={root} sourceRoot={sourceRoot} />;
}

export function TranscriptAnnotationControls({ sessionId, root }: { sessionId: string; root: HTMLElement }) {
  const [, setOpen] = useAtom(openChatAnnotationAtom(sessionId));
  const [target, setTarget] = useState<{ range: Range; anchor: SelectionAnchor; messageId: string } | null>(null);
  const { refs, floatingStyles, middlewareData } = useFloating({
    placement: 'top', strategy: 'fixed',
    middleware: [offset(4), flip({ boundary: root }), shift({ boundary: root, padding: 6, crossAxis: true }), hide({ boundary: root })],
    whileElementsMounted: autoUpdate,
  });
  useEffect(() => {
    const update = () => {
      const selection = window.getSelection();
      const range = selection?.rangeCount && selection.getRangeAt(0);
      if (!range || !root.contains(range.startContainer)) {
        setTarget(null);
        return;
      }
      const row = range.startContainer.parentElement?.closest<HTMLElement>('[data-annotation-message-id]');
      const anchor = row ? selectionAnchor(row, range) : null;
      const messageId = row?.dataset.annotationMessageId;
      setTarget(anchor && messageId ? { range: range.cloneRange(), anchor, messageId } : null);
    };
    document.addEventListener('selectionchange', update);
    return () => document.removeEventListener('selectionchange', update);
  }, [root]);
  useEffect(() => {
    if (!target) return;
    const selection = window.getSelection();
    const focusAtStart = selection?.focusNode === target.range.startContainer && selection?.focusOffset === target.range.startOffset;
    refs.setPositionReference({
      getBoundingClientRect: () => {
        const rects = target.range.getClientRects();
        return rects.length ? rects[focusAtStart ? 0 : rects.length - 1] : target.range.getBoundingClientRect();
      },
      contextElement: root,
    });
  }, [target, refs]);
  const sourceRoot = useCallback((source: ChatAnnotationSource) =>
    source.type === 'message' && source.sessionId === sessionId
      ? root.querySelector<HTMLElement>(`[data-annotation-message-id="${CSS.escape(source.messageId)}"]`)
      : null, [sessionId, root]);
  return (
    <>
      <ChatAnnotationMarkers sessionId={sessionId} root={root} sourceRoot={sourceRoot} />
      {target && (
        <FloatingPortal>
          <button ref={refs.setFloating} style={{ ...floatingStyles, visibility: middlewareData?.hide?.referenceHidden ? 'hidden' : undefined }} type="button"
            className="add-transcript-selection-to-chat z-50 rounded border border-nim bg-nim px-2 py-1 text-xs text-nim shadow"
            onMouseDown={event => event.preventDefault()}
            onClick={() => {
              addAnnotation(sessionId, { type: 'message', sessionId, messageId: target.messageId }, target.anchor, setOpen);
              setTarget(null);
            }}>
            Add to chat
          </button>
        </FloatingPortal>
      )}
    </>
  );
}

export function DraftAnnotationList({ sessionId, navigate }: {
  sessionId: string;
  navigate: (annotation: ChatAnnotation) => void;
}) {
  const [draft] = useAtom(chatAnnotationDraftAtom(sessionId));
  const [open, setOpen] = useAtom(editDraftAnnotationAtom(sessionId));
  const [, setReveal] = useAtom(revealChatAnnotationAtom(sessionId));
  const editorRef = useRef<HTMLDivElement>(null);
  const finish = useCallback(() => {
    if (open) updateChatAnnotationDraft(sessionId, previous => previous.filter(a => a.id !== open || a.comment.trim()));
    void flushChatAnnotationDraft(sessionId).catch(() => {});
    setOpen(null);
  }, [sessionId, open, setOpen]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      if (!(event.target instanceof Node) || !editorRef.current?.contains(event.target)) finish();
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('wheel', outside, { capture: true, passive: true });
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('wheel', outside, true);
    };
  }, [open, finish]);
  if (!draft.length) return null;
  return (
    <details className="draft-annotation-list px-2 pb-1 text-xs">
      <summary className="w-fit cursor-pointer rounded border border-nim px-2 py-1">
        {draft.length} {draft.length === 1 ? 'annotation' : 'annotations'}
      </summary>
      <ol className="max-h-44 overflow-auto">
        {draft.map((annotation, index) => (
          <li key={annotation.id} className="border-b border-nim py-1">
            <button type="button" className="w-full truncate text-left text-nim-primary"
              title={chatAnnotationSourceLabel(annotation.source)}
              onClick={() => { if (open === annotation.id) finish(); else setOpen(annotation.id); }}>
              {index + 1}. {annotation.quote}
            </button>
            {open === annotation.id && (
              <div ref={editorRef} className="flex gap-1" onBlur={event => {
                if (!event.currentTarget.contains(event.relatedTarget)) finish();
              }} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); finish(); } }}>
                <textarea autoFocus aria-label="Annotation comment in draft" rows={2} value={annotation.comment}
                  className="min-w-0 flex-1 rounded border border-nim bg-nim p-1 text-nim"
                  onChange={event => {
                    const comment = event.currentTarget.value;
                    updateChatAnnotationDraft(sessionId, previous => previous.map(a => a.id === annotation.id ? { ...a, comment } : a));
                  }} />
                <button type="button" aria-label="Find annotation source" onClick={() => {
                  void flushChatAnnotationDraft(sessionId).catch(() => {});
                  setOpen(null);
                  setReveal(annotation.id);
                  navigate(annotation);
                }}>Find</button>
              </div>
            )}
          </li>
        ))}
      </ol>
    </details>
  );
}
