/**
 * Markdown import/export for the static 2x2 block: a ```2x2 fence whose body
 * the node keeps verbatim.
 */

import type { MultilineElementTransformer } from '@lexical/markdown';

import { $createQuadrantNode, $isQuadrantNode, QUADRANT_FENCE_LANGUAGE, QuadrantNode } from './QuadrantNodeCore';

export const QUADRANT_TRANSFORMER: MultilineElementTransformer = {
  dependencies: [QuadrantNode],
  export: (node) => {
    if (!$isQuadrantNode(node)) return null;
    return `\`\`\`${QUADRANT_FENCE_LANGUAGE}\n${node.getSource()}\n\`\`\``;
  },
  regExpStart: /^[ \t]*```2x2[ \t]*$/,
  regExpEnd: { optional: true, regExp: /^[ \t]*```[ \t]*$/ },
  replace: (rootNode, _children, _startMatch, _endMatch, linesInBetween) => {
    rootNode.append($createQuadrantNode({ source: (linesInBetween ?? []).join('\n').replace(/^\n+|\n+$/g, '') }));
  },
  type: 'multiline-element',
};
