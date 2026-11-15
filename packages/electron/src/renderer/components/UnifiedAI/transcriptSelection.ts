/** UI labels and icon glyph names are not part of a quoted message. */
export function annotationTextNodes(root: HTMLElement, transcript = false): Node[] {
  const ignored = '.material-symbols-outlined,.rich-transcript-message-header,.rich-transcript-message-copy-action,.rich-transcript-turn-elapsed';
  const scoped = transcript && (root.matches('[data-annotation-message-id]') || Boolean(root.querySelector('[data-annotation-message-id]')));
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: node => (transcript && node.parentElement?.closest(ignored)) ||
      (scoped && !node.parentElement?.closest('[data-annotation-message-id]')) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  const nodes: Node[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node);
  return nodes;
}

/** A native selection may start on a newline or extend outside the transcript.
 * Locate its actual text boundaries without including surrounding application UI. */
export function transcriptTextRange(root: HTMLElement, selection: Range): Range | null {
  let first: { node: Node; offset: number } | undefined;
  let last: { node: Node; offset: number } | undefined;
  for (const node of annotationTextNodes(root, true)) {
    if (!selection.intersectsNode(node)) continue;
    const text = node.textContent ?? '';
    const start = node === selection.startContainer ? selection.startOffset : 0;
    const end = node === selection.endContainer ? selection.endOffset : text.length;
    const part = text.slice(start, end);
    const leading = part.search(/\S/);
    if (leading < 0) continue;
    first ??= { node, offset: start + leading };
    last = { node, offset: start + part.trimEnd().length };
  }
  if (!first || !last) return null;
  const range = root.ownerDocument.createRange();
  range.setStart(first.node, first.offset);
  range.setEnd(last.node, last.offset);
  return range;
}

export function selectionFocusRect(range: Range, backward: boolean): DOMRect {
  const caret = range.cloneRange();
  caret.collapse(backward);
  const rect = caret.getBoundingClientRect();
  if (rect.height || rect.width) return rect;
  const lines = Array.from(range.getClientRects()).filter(line => line.width > 0 && line.height > 0);
  const line = backward ? lines[0] : lines.at(-1);
  return line ? new DOMRect(backward ? line.left : line.right, line.top, 0, line.height) : rect;
}

/** Anchor a persistent annotation to its last visible character, not a wrapped
 * selection's bounding box or a trailing newline/space. */
export function annotationEndRect(textRanges: readonly Range[]): DOMRect {
  for (let index = textRanges.length - 1; index >= 0; index--) {
    const range = textRanges[index];
    const text = range.toString().trimEnd();
    if (!text) continue;
    const character = range.cloneRange();
    const end = range.startOffset + text.length;
    character.setEnd(range.startContainer, end);
    character.setStart(range.startContainer, end - [...text].at(-1)!.length);
    const rect = character.getBoundingClientRect();
    return new DOMRect(rect.right, rect.top, 0, rect.height);
  }
  return new DOMRect();
}
