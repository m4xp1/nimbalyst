import type { Transformer } from '@lexical/markdown';
import type { LexicalEditor } from 'lexical';
import { EXTERNAL_CONTENT_UPDATE_TAG } from './applyExternalMarkdown';
import { $convertToEnhancedMarkdownString } from './markdown/EnhancedMarkdownExport';

export function registerMarkdownDirtyListener(
  editor: LexicalEditor,
  transformers: Transformer[],
  onDirty: () => void,
): () => void {
  const serialize = () => $convertToEnhancedMarkdownString(transformers);
  let previous = editor.getEditorState().read(serialize);
  return editor.registerUpdateListener(({ editorState, dirtyElements, dirtyLeaves, tags }) => {
    if (dirtyElements.size === 0 && dirtyLeaves.size === 0) return;
    // Lexical's dirty nodes include selection/decorator bookkeeping. Only a
    // change to the persisted Markdown should start autosave; opening a file
    // must never rewrite it through a formatter. No first-update heuristic:
    // the first update can already be the user's first real edit.
    const current = editorState.read(serialize);
    if (current === previous) return;
    previous = current;
    // An external replacement is the new baseline, not unsaved local work.
    if (tags.has(EXTERNAL_CONTENT_UPDATE_TAG)) return;
    onDirty();
  });
}
