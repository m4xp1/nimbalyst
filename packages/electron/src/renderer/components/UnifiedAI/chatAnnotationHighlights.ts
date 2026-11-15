// Each mounted document/transcript contributes its own ranges. Removing one
// surface must not clear another surface's annotations in the same window.
const surfaces = new Map<object, readonly Range[]>();

export function registerChatAnnotationHighlights(ranges: readonly Range[]): () => void {
  if (!globalThis.CSS?.highlights || typeof Highlight === 'undefined') return () => {};
  const owner = {};
  const repaint = () => {
    const active = [...surfaces.values()].flat();
    if (!active.length) CSS.highlights.delete('chat-annotations');
    else {
      const highlight = new Highlight(...active);
      // Native selection and find-in-transcript highlights stay legible above it.
      highlight.priority = -1;
      CSS.highlights.set('chat-annotations', highlight);
    }
  };
  surfaces.set(owner, ranges);
  repaint();
  return () => { surfaces.delete(owner); repaint(); };
}
