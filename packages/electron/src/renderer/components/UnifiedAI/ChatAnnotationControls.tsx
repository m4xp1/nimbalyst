import React, { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { atom, useAtom, useAtomValue } from 'jotai';
import { FloatingPortal, autoUpdate, detectOverflow, flip, hide, offset, shift, size, useFloating } from '@floating-ui/react';
import { $setSelection, type LexicalEditor } from 'lexical';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import {
  chatAnnotationSourceLabel, findChatAnnotationOffset,
  type ChatAnnotation, type ChatAnnotationSource,
} from '@nimbalyst/runtime/ai/chatAnnotations';
import type { FloatingTextToolbarAction } from '@nimbalyst/runtime/editor/plugins/FloatingTextFormatToolbarPlugin/types';
import {
  AnnotationSessionContext, chatAnnotationDraftAtom, flushChatAnnotationDraft,
  openChatAnnotationAtom, revealChatAnnotationAtom, updateChatAnnotationDraft, chatTextSelectionAtom,
  type ChatAnnotationEditorRequest,
} from './chatAnnotationDraft';
import { annotationEndRect, annotationTextNodes, selectionFocusRect, transcriptTextRange } from './transcriptSelection';
import { registerChatAnnotationHighlights } from './chatAnnotationHighlights';
import { clearTextSelection, selectionPathsMatch } from './TextSelectionIndicator';

type SelectionAnchor = Pick<ChatAnnotation, 'quote' | 'before' | 'after'>;
const noAnnotationSession = atom<string | null>(null);

function annotationClickPosition(event: React.MouseEvent<HTMLElement>): { x: number; y: number } {
  if (event.detail) return { x: event.clientX, y: event.clientY };
  // Keyboard activation has no pointer coordinates; use the focused button.
  const rect = event.currentTarget.getBoundingClientRect();
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

function textInRange(nodes: Node[], range: Range): string {
  return nodes.filter(node => range.intersectsNode(node)).map(node => (node.textContent ?? '').slice(
    node === range.startContainer ? range.startOffset : 0,
    node === range.endContainer ? range.endOffset : undefined,
  )).join('');
}

function selectionAnchor(root: HTMLElement, range: Range, transcript = false): SelectionAnchor | null {
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const nodes = annotationTextNodes(root, transcript);
  const quote = textInRange(nodes, range);
  if (!quote.trim()) return null;
  const textBefore = range.cloneRange();
  textBefore.selectNodeContents(root);
  textBefore.setEnd(range.startContainer, range.startOffset);
  const text = nodes.map(node => node.textContent ?? '').join('');
  const start = textInRange(nodes, textBefore).length;
  return { quote, before: text.slice(Math.max(0, start - 48), start), after: text.slice(start + quote.length, start + quote.length + 48) };
}

function restoreRange(roots: HTMLElement[], annotation: ChatAnnotation): { range: Range; textRanges: Range[] } | null {
  const nodes = roots.flatMap(root => annotationTextNodes(root, annotation.source.type === 'message'));
  const start = findChatAnnotationOffset(nodes.map(node => node.textContent ?? '').join(''), annotation);
  if (start === null) return null;
  const end = start + annotation.quote.length;
  const range = document.createRange();
  const textRanges: Range[] = [];
  let index = 0;
  let foundStart = false;
  for (const node of nodes) {
    const boundary = index + (node.textContent?.length ?? 0);
    if (start < boundary && end > index) {
      const textRange = document.createRange();
      textRange.setStart(node, Math.max(0, start - index));
      textRange.setEnd(node, Math.min(boundary, end) - index);
      textRanges.push(textRange);
    }
    if (!foundStart && start < boundary) {
      range.setStart(node, start - index);
      foundStart = true;
    }
    if (foundStart && end <= boundary) {
      range.setEnd(node, end - index);
      return { range, textRanges };
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
  if (source.type === 'file') clearTextSelection(source.filePath);
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
    label: 'Add annotation',
    icon: <MaterialSymbol icon="chat_bubble" size={16} />,
    availableWhenReadOnly: true,
    onSelect: event => {
      const selection = window.getSelection();
      if (!selection?.rangeCount) return;
      const anchor = selectionAnchor(root, selection.getRangeAt(0));
      if (!anchor) return;
      const position = annotationClickPosition(event);
      // Clearing only the DOM range lets Lexical restore its previous selection.
      editor?.update(() => $setSelection(null), { discrete: true });
      addAnnotation(sessionId, { type: 'file', filePath }, anchor,
        id => openAnnotation({ id, root, ...position }));
    },
  }], [sessionId, root, filePath, editor, openAnnotation]);
  return { actions, sessionId, root };
}

function AnnotationMarker({ textRanges, boundary, index, onClick, reveal, onRevealed }: {
  textRanges: Range[];
  boundary: HTMLElement;
  index: number;
  onClick: React.MouseEventHandler<HTMLButtonElement>;
  reveal: boolean;
  onRevealed: () => void;
}) {
  const marker = useFloating({
    placement: 'right-start',
    strategy: 'fixed',
    middleware: [offset(({ rects }) => ({ mainAxis: 1, crossAxis: -rects.floating.height / 2 })),
      shift({ boundary, padding: 2, mainAxis: false, crossAxis: true }), hide({ boundary }), {
      name: 'annotationClip',
      async fn(state) {
        const overflow = await detectOverflow(state, { boundary });
        const edges = [overflow.top, overflow.right, overflow.bottom, overflow.left].map(value => Math.max(0, value));
        return { data: { clipPath: edges.some(Boolean) ? `inset(${edges.map(value => `${value}px`).join(' ')})` : undefined } };
      },
    }],
    whileElementsMounted: autoUpdate,
  });
  useEffect(() => {
    marker.refs.setPositionReference({
      getBoundingClientRect: () => annotationEndRect(textRanges),
      contextElement: textRanges.at(-1)?.endContainer.parentElement ?? undefined,
    });
  }, [marker.refs, textRanges]);
  useEffect(() => {
    if (!reveal) return;
    let frame = 0, attempts = 0, stableFrames = 0;
    let previous: DOMRect | undefined;
    const settle = () => {
      const end = annotationEndRect(textRanges);
      const viewport = boundary.getBoundingClientRect();
      const badge = marker.refs.floating.current?.getBoundingClientRect();
      const height = badge?.height || 16, width = badge?.width || 16;
      const top = end.top - height / 2, right = end.right + 1 + width;
      const outsideY = top < viewport.top + 12 || top + height > viewport.bottom - 12;
      const outsideX = end.right < viewport.left + 12 || right > viewport.right - 12;
      // Reveal the final glyph and its badge, even inside one very tall row.
      // Limit scrolling to this surface; ancestor panels must not move.
      if (outsideY || outsideX) {
        boundary.scrollBy({
          top: outsideY ? end.top - (viewport.top + viewport.height / 2) : 0,
          left: outsideX ? right - (viewport.left + viewport.width / 2) : 0,
          behavior: 'instant',
        });
      }
      // Virtual rows may be measured again after the initial jump.
      stableFrames = previous && end.x === previous.x && end.y === previous.y ? stableFrames + 1 : 0;
      previous = end;
      if (stableFrames >= 2 || ++attempts >= 30) onRevealed();
      else frame = requestAnimationFrame(settle);
    };
    frame = requestAnimationFrame(settle);
    return () => cancelAnimationFrame(frame);
  }, [reveal, textRanges, boundary, marker.refs, onRevealed]);
  return <FloatingPortal>
    <button ref={marker.refs.setFloating} type="button"
      style={{ ...marker.floatingStyles, clipPath: marker.middlewareData.annotationClip?.clipPath, visibility: marker.middlewareData?.hide?.referenceHidden ? 'hidden' : undefined }}
      onClick={onClick}
      aria-label={`Edit annotation ${index}`} className="chat-annotation-marker z-50 flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--nim-annotation-marker)] px-1 text-[11px] leading-none text-[var(--nim-annotation-marker-text)] shadow">
      {index}
    </button>
  </FloatingPortal>;
}

function AnnotationEditor({ sessionId, annotation, request, boundary, close }: {
  sessionId: string;
  annotation: ChatAnnotation;
  request: ChatAnnotationEditorRequest;
  boundary: HTMLElement;
  close: (id: string) => void;
}) {
  const editor = useFloating({
    open: true,
    placement: 'bottom-start',
    strategy: 'fixed',
    middleware: [offset(8), flip({ boundary, padding: 6 }), shift({ boundary, padding: 6, crossAxis: true }),
      size({ boundary, padding: 6, apply({ availableWidth, availableHeight, elements }) {
        Object.assign(elements.floating.style, { maxWidth: `${Math.max(0, availableWidth)}px`, maxHeight: `${Math.max(0, availableHeight)}px` });
      } })],
    whileElementsMounted: autoUpdate,
  });
  const editorRefs = editor.refs;
  useLayoutEffect(() => {
    editorRefs.setPositionReference({
      getBoundingClientRect: () => new DOMRect(request.x, request.y, 0, 0),
      contextElement: boundary,
    });
  }, [editorRefs, request, boundary]);
  const finish = useCallback(() => close(annotation.id), [annotation.id, close]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !editorRefs.floating.current?.contains(event.target)) finish();
    };
    const scroll = (event: Event) => {
      if (!(event.target instanceof Node) || !editorRefs.floating.current?.contains(event.target)) finish();
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('wheel', scroll, { capture: true, passive: true });
    document.addEventListener('scroll', scroll, { capture: true, passive: true });
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('wheel', scroll, true);
      document.removeEventListener('scroll', scroll, true);
    };
  }, [finish, editorRefs]);
  return (
    <FloatingPortal>
          <form ref={editorRefs.setFloating}
            style={{ ...editor.floatingStyles, width: 'calc((15rem + 2px) * 1.728)' }}
            className="chat-annotation-editor z-[51] flex items-start overflow-auto rounded-lg border border-nim bg-nim-secondary p-2 shadow-md" onSubmit={event => {
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
              className="w-full min-w-0 max-h-40 resize-y rounded border border-nim bg-nim p-1 text-nim"
            />
          </form>
    </FloatingPortal>
  );
}

export function ChatAnnotationMarkers({ sessionId, root, sourceRoot }: {
  sessionId: string;
  root: HTMLElement;
  sourceRoot: (source: ChatAnnotationSource) => HTMLElement | HTMLElement[] | null;
}) {
  const [draft] = useAtom(chatAnnotationDraftAtom(sessionId));
  const [open, setOpen] = useAtom(openChatAnnotationAtom(sessionId));
  const [reveal, setReveal] = useAtom(revealChatAnnotationAtom(sessionId));
  const [revision, setRevision] = useState(0);
  const finish = useCallback((id: string) => {
    // Read the shared draft so closing in the same event loop keeps the last keystroke.
    updateChatAnnotationDraft(sessionId, draft => draft.filter(a => a.id !== id || a.comment.trim()));
    void flushChatAnnotationDraft(sessionId).catch(() => {});
    setOpen(null);
  }, [sessionId, setOpen]);
  useEffect(() => () => {
    setOpen(current => current?.root === root ? null : current);
  }, [root, setOpen]);
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
    const roots = owner ? Array.isArray(owner) ? owner : [owner] : [];
    const range = roots.length && roots.every(root => root.getClientRects().length) ? restoreRange(roots, annotation) : null;
    return range ? [{ annotation, index: index + 1, ...range }] : [];
  }), [draft, sourceRoot, revision]);
  useLayoutEffect(() => registerChatAnnotationHighlights(markers.flatMap(marker => marker.textRanges)), [markers]);
  const finishReveal = useCallback(() => setReveal(null), [setReveal]);
  const boundary = root.closest<HTMLElement>('.editor-scroller') ?? root.querySelector<HTMLElement>('.rich-transcript-vlist') ?? root.closest<HTMLElement>('.tab-editor-wrapper') ?? root;
  const editing = open?.root === root ? draft.find(annotation => annotation.id === open.id) : undefined;
  return <>
    {markers.map(({ annotation, index, textRanges }) => (
      <AnnotationMarker key={annotation.id} textRanges={textRanges} boundary={boundary} index={index}
        reveal={reveal === annotation.id} onRevealed={finishReveal}
        onClick={event => {
          if (editing?.id === annotation.id) finish(annotation.id);
          else setOpen({ id: annotation.id, root, ...annotationClickPosition(event) });
        }} />
    ))}
    {editing && open && <AnnotationEditor key={editing.id} sessionId={sessionId} annotation={editing}
      request={open} boundary={boundary} close={finish} />}
  </>;
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
  const [chatSelection, setChatSelection] = useAtom(chatTextSelectionAtom(sessionId));
  const ownedSelection = useRef<string | null>(null);
  const [target, setTarget] = useState<{ range: Range; anchor: SelectionAnchor; source: ChatAnnotationSource; backward: boolean } | null>(null);
  const selecting = useRef(false);
  const [dragging, setDragging] = useState(false);
  const { refs, floatingStyles, middlewareData, update: updatePosition } = useFloating({
    placement: 'top', strategy: 'fixed',
    middleware: [offset(4), flip({ boundary: root }), shift({ boundary: root, padding: 6, crossAxis: true }), hide({ boundary: root })],
    whileElementsMounted: autoUpdate,
  });
  useEffect(() => {
    const clearOwnedSelection = () => {
      const id = ownedSelection.current;
      ownedSelection.current = null;
      if (id) setChatSelection(previous => previous?.id === id ? null : previous);
    };
    const update = () => {
      const selection = window.getSelection();
      const original = selection?.rangeCount ? selection.getRangeAt(0) : null;
      if (!original || original.collapsed || (!selecting.current &&
          (!root.contains(original.startContainer) || !root.contains(original.endContainer)))) {
        setTarget(null);
        // Moving focus into the composer must still allow asking about the quote.
        // Explicit deselection in the transcript, or elsewhere, cancels its context.
        if (selecting.current || !document.activeElement?.closest('.ai-chat-input')) clearOwnedSelection();
        return;
      }
      const backward = selection?.focusNode === original.startContainer && selection.focusOffset === original.startOffset;
      const range = transcriptTextRange(root, original);
      const row = range?.startContainer.parentElement?.closest<HTMLElement>('[data-annotation-message-id]');
      const lastRow = range?.endContainer.parentElement?.closest<HTMLElement>('[data-annotation-message-id]');
      const messageId = row?.dataset.annotationMessageId;
      const endMessageId = lastRow?.dataset.annotationMessageId;
      const messageSequence = Number(row?.dataset.annotationMessageSequence);
      const endMessageSequence = Number(lastRow?.dataset.annotationMessageSequence);
      const anchor = range && row && lastRow ? selectionAnchor(row === lastRow ? row : root, range, true) : null;
      if (!range || !anchor || !messageId || !endMessageId || !Number.isSafeInteger(messageSequence) || !Number.isSafeInteger(endMessageSequence)) {
        setTarget(null); clearOwnedSelection(); return;
      }
      if (selecting.current && (!root.contains(original.startContainer) || !root.contains(original.endContainer))) {
        selection?.setBaseAndExtent(
          backward ? range.endContainer : range.startContainer, backward ? range.endOffset : range.startOffset,
          backward ? range.startContainer : range.endContainer, backward ? range.startOffset : range.endOffset,
        );
      }
      const source: ChatAnnotationSource = { type: 'message', sessionId, messageId, messageSequence,
        ...(endMessageId !== messageId ? { endMessageId, endMessageSequence } : {}) };
      setTarget({ range, anchor, source, backward });
      setChatSelection(previous => {
        const next = previous?.id === ownedSelection.current && previous?.quote === anchor.quote && JSON.stringify(previous.source) === JSON.stringify(source)
          ? previous : { id: crypto.randomUUID(), source, ...anchor, comment: '' };
        ownedSelection.current = next.id;
        return next;
      });
    };
    const begin = (event: PointerEvent) => {
      if (event.button !== 0 || (event.target instanceof Element && event.target.closest('input,textarea,[contenteditable="true"]'))) return;
      selecting.current = true;
      setDragging(true);
    };
    const end = () => {
      if (selecting.current) update();
      selecting.current = false;
      setDragging(false);
    };
    root.addEventListener('pointerdown', begin, true);
    document.addEventListener('pointerup', end);
    document.addEventListener('pointercancel', end);
    document.addEventListener('selectionchange', update);
    return () => {
      root.removeEventListener('pointerdown', begin, true);
      document.removeEventListener('pointerup', end);
      document.removeEventListener('pointercancel', end);
      document.removeEventListener('selectionchange', update);
      clearOwnedSelection();
    };
  }, [root, sessionId, setChatSelection]);
  useEffect(() => {
    // Removing the chip or submitting its context also retires the native range,
    // so a later selectionchange cannot silently attach the same quote again.
    if (!ownedSelection.current || chatSelection?.id === ownedSelection.current) return;
    ownedSelection.current = null;
    setTarget(null);
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    if (range && root.contains(range.startContainer) && root.contains(range.endContainer)) selection?.removeAllRanges();
  }, [chatSelection, root]);
  useEffect(() => {
    if (!target) return;
    refs.setPositionReference({
      getBoundingClientRect: () => selectionFocusRect(target.range, target.backward),
      contextElement: (target.backward ? target.range.startContainer : target.range.endContainer).parentElement ?? root,
    });
  }, [target, refs, root]);
  useEffect(() => {
    const update = () => { void updatePosition?.(); };
    root.addEventListener('scroll', update, true);
    return () => root.removeEventListener('scroll', update, true);
  }, [root, updatePosition]);
  const sourceRoot = useCallback((source: ChatAnnotationSource) => {
    if (source.type !== 'message' || source.sessionId !== sessionId || source.messageSequence === undefined) return null;
    const start = root.querySelector<HTMLElement>(`[data-annotation-message-sequence="${source.messageSequence}"]`);
    if (!start || source.endMessageSequence === undefined) return start;
    const end = root.querySelector<HTMLElement>(`[data-annotation-message-sequence="${source.endMessageSequence}"]`);
    if (!end) return null;
    return Array.from(root.querySelectorAll<HTMLElement>('[data-annotation-message-sequence]')).filter(element => {
      const sequence = Number(element.dataset.annotationMessageSequence);
      return sequence >= source.messageSequence! && sequence <= source.endMessageSequence!;
    });
  }, [sessionId, root]);
  return (
    <>
      <ChatAnnotationMarkers sessionId={sessionId} root={root} sourceRoot={sourceRoot} />
      {target && !dragging && (
        <FloatingPortal>
          <button ref={refs.setFloating} style={{ ...floatingStyles, visibility: middlewareData?.hide?.referenceHidden ? 'hidden' : undefined }} type="button"
            className="add-transcript-selection-to-chat select-none z-50 rounded border border-nim bg-nim px-2 py-1 text-xs text-nim shadow"
            draggable={false}
            onPointerDown={event => event.preventDefault()}
            onMouseDown={event => event.preventDefault()}
            onDragStart={event => event.preventDefault()}
            onClick={event => {
              const position = annotationClickPosition(event);
              setChatSelection(null);
              addAnnotation(sessionId, target.source, target.anchor, id => setOpen({ id, root, ...position }));
              setTarget(null);
            }}>
            Add annotation
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
  // Only the draft content is shared. A hidden session view must not dismiss
  // another view's editor from its document-level outside-click listener.
  const [open, setOpen] = useState<string | null>(null);
  const [, setSourceEditor] = useAtom(openChatAnnotationAtom(sessionId));
  const [, setReveal] = useAtom(revealChatAnnotationAtom(sessionId));
  const editorRef = useRef<HTMLDetailsElement>(null);
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
    <details ref={editorRef} className="draft-annotation-list pb-1 text-xs text-nim" onBlur={event => {
      if (!event.currentTarget.contains(event.relatedTarget)) finish();
    }}>
      <summary className="w-fit cursor-pointer rounded border border-nim px-2 py-1">
        {draft.length} {draft.length === 1 ? 'annotation' : 'annotations'}
      </summary>
      <ol className="max-h-44 overflow-auto">
        {draft.map((annotation, index) => (
          <li key={annotation.id} className="border-b border-nim py-1">
            <div className="flex min-w-0 items-center gap-1">
            <button type="button" className="min-w-0 flex-1 truncate text-left text-nim"
              title={chatAnnotationSourceLabel(annotation.source)}
              onClick={() => { if (open === annotation.id) finish(); else setOpen(annotation.id); }}>
              {index + 1}. {annotation.quote}
            </button>
            <button type="button" aria-label="Find annotation source" title="Find annotation source"
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-nim-muted hover:bg-nim-tertiary"
              onClick={() => {
                void flushChatAnnotationDraft(sessionId).catch(() => {});
                setOpen(null);
                setSourceEditor(null);
                setReveal(annotation.id);
                navigate(annotation);
              }}><MaterialSymbol icon="my_location" size={16} /></button>
            <button type="button" aria-label="Delete annotation" title="Delete annotation"
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-nim-muted hover:bg-nim-tertiary"
              onClick={() => {
                updateChatAnnotationDraft(sessionId, previous => previous.filter(item => item.id !== annotation.id));
                if (open === annotation.id) setOpen(null);
                void flushChatAnnotationDraft(sessionId).catch(() => {});
              }}><MaterialSymbol icon="delete" size={16} /></button>
            </div>
            {open === annotation.id && (
              <div className="flex gap-1" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); finish(); } }}>
                <textarea autoFocus aria-label="Annotation comment in draft" rows={2} value={annotation.comment}
                  className="min-w-0 flex-1 rounded border border-nim bg-nim p-1 text-nim"
                  onChange={event => {
                    const comment = event.currentTarget.value;
                    updateChatAnnotationDraft(sessionId, previous => previous.map(a => a.id === annotation.id ? { ...a, comment } : a));
                  }} />
              </div>
            )}
          </li>
        ))}
      </ol>
    </details>
  );
}
