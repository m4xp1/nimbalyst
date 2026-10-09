/**
 * The rule that turns a paragraph holding only an embeddable link into an
 * embed, and the whole-tree rescan that re-applies it. Used by the editor's
 * `EmbedExtension` and by the diff engine after it rebuilds a body, which also
 * runs headless in the collab worker, so this module stays React-free.
 */
import {
  $getRoot,
  $isElementNode,
  $isParagraphNode,
  $isTextNode,
  type LexicalNode,
} from 'lexical';
import { $isLinkNode, type LinkNode } from '@lexical/link';

import { $createEmbeddedFileNode } from './EmbeddedFileNodeCore';
import { parseEmbedAttrs } from './embedAttrs';
import { isEmbeddableUrl } from './embeddableExtensions';

export function isEmptyTextNode(node: LexicalNode): boolean {
  return $isTextNode(node) && node.getTextContent() === '';
}

function isEmbedOptOut(title: string | null | undefined): boolean {
  if (!title) return false;
  return parseEmbedAttrs(title).embed === 'false';
}

export function $upgradeParagraphIsolatedLinkToEmbed(linkNode: LinkNode): void {
  // Skip auto-links (`<https://...>` style) -- those aren't filesystem refs.
  if (!$isLinkNode(linkNode)) return;

  const url = linkNode.getURL();
  const title = linkNode.getTitle() ?? '';
  const attrs = parseEmbedAttrs(title);
  if (!isEmbeddableUrl(url, attrs.embedType)) return;

  // Respect explicit user opt-out (set by the Tab-downgrade path).
  if (isEmbedOptOut(title)) return;

  const parent = linkNode.getParent();
  if (!parent || !$isParagraphNode(parent)) return;

  // Paragraph must contain only this link (ignoring empty text-node siblings).
  const meaningfulChildren = parent.getChildren().filter((c) => !isEmptyTextNode(c));
  if (meaningfulChildren.length !== 1 || meaningfulChildren[0] !== linkNode) {
    return;
  }

  const label = linkNode.getTextContent();
  const embedNode = $createEmbeddedFileNode({
    src: url,
    label,
    attrs,
  });

  // Replace the entire paragraph -- embeds are block-level, not inline.
  parent.replace(embedNode);
}

/**
 * Walk every node in the editor and upgrade any qualifying paragraph-
 * isolated `LinkNode` to an embed. Needed because the embeddable file-
 * type set is usually empty when the host markdown doc first loads
 * (extensions register their types AFTER initial import), so the
 * `registerNodeTransform` callbacks that ran on import all saw an empty
 * set and left links alone. This scan re-runs the upgrade rule against
 * the live tree once the set changes.
 */
export function $rescanForEmbedUpgrade(): void {
  const stack: LexicalNode[] = [$getRoot()];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if ($isLinkNode(node)) {
      $upgradeParagraphIsolatedLinkToEmbed(node);
      // Don't descend into a LinkNode's children -- text content can't
      // host another link.
      continue;
    }
    if ($isElementNode(node)) {
      const children = node.getChildren();
      for (const child of children) stack.push(child);
    }
  }
}
