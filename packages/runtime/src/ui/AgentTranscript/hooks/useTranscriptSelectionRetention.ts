import { useEffect, useMemo, useState, type RefObject } from 'react';

/** Keep selected rows in virtua's DOM while the user scrolls away. Increasing
 * the global overscan would only postpone selection loss and render extra rows. */
export function useTranscriptSelectionRetention(root: RefObject<HTMLElement | null>, messageIds: readonly string[]): number[] {
  const [retained, setRetained] = useState<readonly string[]>([]);
  useEffect(() => {
    const update = () => {
      const selection = document.getSelection();
      const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
      const element = root.current;
      const rowIndex = (node: Node) => {
        const row = (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>('[data-message-index]');
        return row && element?.contains(row) ? Number(row.dataset.messageIndex) : -1;
      };
      let next: readonly string[] = [];
      if (range && !range.collapsed && element?.contains(range.startContainer) && element.contains(range.endContainer)) {
        const first = rowIndex(range.startContainer), last = rowIndex(range.endContainer);
        if (first >= 0 && last >= first) next = messageIds.slice(first, last + 1);
      }
      setRetained(previous => previous.length === next.length && previous.every((id, i) => id === next[i]) ? previous : next);
    };
    document.addEventListener('selectionchange', update);
    document.addEventListener('pointerup', update);
    return () => {
      document.removeEventListener('selectionchange', update);
      document.removeEventListener('pointerup', update);
    };
  }, [root, messageIds]);
  return useMemo(() => {
    const selected = new Set(retained);
    return messageIds.flatMap((id, index) => selected.has(id) ? [index] : []);
  }, [retained, messageIds]);
}
