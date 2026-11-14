/**
 * Assigns GitHub-style slug ids to rendered heading elements so anchor
 * links like `[Section](#section)` have a target to scroll to. The
 * stock `@lexical/rich-text` `HeadingNode.createDOM()` emits
 * `<h1>...<h6>` with no id, so without this extension the renderer's
 * link click handler has nothing to query.
 *
 * Headless extension: registers a mutation listener directly on the
 * editor instance instead of mounting a React plugin. Scoped to
 * `editor.getRootElement()` so each open editor manages its own
 * heading ids (multi-file safe).
 */

import { defineExtension, type LexicalEditor } from 'lexical';
import { HeadingNode } from '@lexical/rich-text';

import { headingSlugs } from '../../utils/headingNavigation';

function recomputeHeadingIds(editor: LexicalEditor): void {
  const root = editor.getRootElement();
  if (!root) {
    return;
  }
  const headings = root.querySelectorAll('h1, h2, h3, h4, h5, h6');
  const slugs = headingSlugs([...headings].map(element => element.textContent ?? ''));
  headings.forEach((element, index) => {
    const slug = slugs[index];
    if (!slug) {
      if (element.id) {
        element.removeAttribute('id');
      }
      return;
    }
    if (element.id !== slug) {
      element.id = slug;
    }
  });
}

export const HeadingAnchorExtension = defineExtension({
  name: '@nimbalyst/editor/heading-anchor',
  register: (editor) => {
    recomputeHeadingIds(editor);
    return editor.registerMutationListener(
      HeadingNode,
      () => {
        recomputeHeadingIds(editor);
      },
      { skipInitialization: false },
    );
  },
});
