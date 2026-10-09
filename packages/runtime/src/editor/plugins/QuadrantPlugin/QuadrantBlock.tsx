/**
 * The static 2x2 block in the editor: the chart drawn from the fence body,
 * an Edit toggle that shows the body as text (saved on blur), and, once the
 * block is clicked to select it, the shared block resize handles. The whole
 * block resizes; its width and the chart's height are saved as the body's
 * `width:` / `height:` lines.
 */

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { useLexicalEditable } from '@lexical/react/useLexicalEditable';
import { useLexicalNodeSelection } from '@lexical/react/useLexicalNodeSelection';
import { $getNodeByKey, CLICK_COMMAND, COMMAND_PRIORITY_LOW, type NodeKey } from 'lexical';

import { DEFAULT_QUADRANT_HEIGHT, QuadrantChart } from '../../../ui/quadrant/QuadrantChart';
import BlockResizer from '../../ui/BlockResizer';
import {
  MAX_QUADRANT_HEIGHT,
  MIN_QUADRANT_HEIGHT,
  MIN_QUADRANT_WIDTH,
  parseQuadrantFence,
  setQuadrantFenceSize,
} from './quadrantFence';
import { $isQuadrantNode } from './QuadrantNodeCore';

const clampHeight = (height: number) => Math.min(MAX_QUADRANT_HEIGHT, Math.max(MIN_QUADRANT_HEIGHT, Math.round(height)));

export function QuadrantBlock({ source, nodeKey }: { source: string; nodeKey: NodeKey }): JSX.Element {
  const [editor] = useLexicalComposerContext();
  const editable = useLexicalEditable();
  const [isSelected, setSelected, clearSelection] = useLexicalNodeSelection(nodeKey);
  const [isResizing, setIsResizing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(source);
  // The chart's height while a drag is in flight; null otherwise.
  const [liveHeight, setLiveHeight] = useState<number | null>(null);
  const blockRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  // Block height minus chart height (padding, footer, open text), so a drag
  // of the block's edge maps to the chart's height.
  const chromeRef = useRef(0);
  useEffect(() => {
    if (!editing) setDraft(source);
  }, [source, editing]);
  const parsed = useMemo(() => parseQuadrantFence(editing ? draft : source), [draft, editing, source]);
  const chartHeight = liveHeight ?? parsed.height ?? DEFAULT_QUADRANT_HEIGHT;

  useLayoutEffect(() => {
    const block = blockRef.current;
    const frame = frameRef.current;
    if (block && frame && !isResizing) chromeRef.current = block.offsetHeight - frame.offsetHeight;
  });

  // Clicking the block (not its Edit button or text) selects it, which shows the handles.
  useEffect(() => editor.registerCommand(
    CLICK_COMMAND,
    (event: MouseEvent) => {
      const block = blockRef.current;
      const target = event.target;
      if (!block || !(target instanceof Element) || !block.contains(target)) return false;
      if (target.closest('button, textarea')) return false;
      if (!event.shiftKey) clearSelection();
      setSelected(true);
      return true;
    },
    COMMAND_PRIORITY_LOW,
  ), [clearSelection, editor, setSelected]);

  const writeSource = (next: string) => {
    editor.update(() => {
      const node = $getNodeByKey(nodeKey);
      if ($isQuadrantNode(node)) node.setSource(next);
    });
  };

  const save = () => {
    setEditing(false);
    if (draft !== source) writeSource(draft);
  };

  const onResizeEnd = (width: number, height: number) => {
    // Delay hiding the handles for the click case, as images do.
    setTimeout(() => setIsResizing(false), 200);
    setLiveHeight(null);
    const block = blockRef.current;
    const column = block?.parentElement?.clientWidth ?? Infinity;
    // Dragged out to the column's edge means "fill the column", not a fixed width.
    const fill = width >= column - 1;
    if (block) {
      // The resizer sized the block inline; the saved fence owns the size now.
      block.style.height = '';
      if (fill) block.style.width = '';
    }
    const size = { width: fill ? null : width, height: clampHeight(height - chromeRef.current) };
    // While the text is open the draft is what gets saved, so the size goes there.
    if (editing) setDraft(setQuadrantFenceSize(draft, size));
    else writeSource(setQuadrantFenceSize(source, size));
  };

  const showHandles = editable && (isSelected || isResizing);

  return (
    <div
      ref={blockRef}
      className={`quadrant-block relative my-3 max-w-full rounded-lg border bg-nim-secondary p-2 ${showHandles ? 'border-[var(--nim-primary)]' : 'border-nim'}`}
      style={parsed.width === undefined ? undefined : { width: `${parsed.width}px` }}
      contentEditable={false}
      data-testid="quadrant-block"
    >
      <QuadrantChart points={parsed.points} {...parsed.labels} height={chartHeight} frameRef={frameRef} />
      <div className="quadrant-block-foot flex items-center gap-3 px-1 pt-1 text-[11px] text-nim-faint">
        {parsed.skipped > 0 ? <span>{parsed.skipped} line{parsed.skipped === 1 ? '' : 's'} without two numbers</span> : null}
        {editable ? (
          <button
            type="button"
            className="ml-auto cursor-pointer border-none bg-transparent p-0 text-[11px] text-nim-link hover:underline"
            data-testid="quadrant-block-edit"
            onClick={() => (editing ? save() : setEditing(true))}
          >
            {editing ? 'Done' : 'Edit'}
          </button>
        ) : null}
      </div>
      {editing ? (
        <textarea
          className="quadrant-block-source mt-1 min-h-[120px] w-full resize-y rounded border border-nim bg-nim-tertiary p-2 font-mono text-xs text-nim focus:border-[var(--nim-border-focus)] focus:outline-none"
          value={draft}
          autoFocus
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={save}
          onKeyDown={(event) => event.stopPropagation()}
          data-testid="quadrant-block-source"
        />
      ) : null}
      {showHandles ? (
        <BlockResizer
          editor={editor}
          targetRef={blockRef}
          minWidth={MIN_QUADRANT_WIDTH}
          minHeight={MIN_QUADRANT_HEIGHT + chromeRef.current}
          maxWidth={blockRef.current?.parentElement?.clientWidth}
          maxHeight={MAX_QUADRANT_HEIGHT + chromeRef.current}
          onResizeStart={() => setIsResizing(true)}
          onResize={(_width, height) => setLiveHeight(clampHeight(height - chromeRef.current))}
          onResizeEnd={onResizeEnd}
        />
      ) : null}
    </div>
  );
}
