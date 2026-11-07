import { describe, expect, it, vi } from 'vitest';
import { $getRoot } from 'lexical';
import { registerMarkdownDirtyListener } from '../registerMarkdownDirtyListener';
import { preserveMarkdownSource } from '../markdown/MarkdownSource';
import { $convertFromEnhancedMarkdownString } from '../markdown/EnhancedMarkdownImport';
import { $convertToEnhancedMarkdownString } from '../markdown/EnhancedMarkdownExport';
import { EXTERNAL_CONTENT_UPDATE_TAG } from '../applyExternalMarkdown';
import { createTestEditor, MARKDOWN_TEST_TRANSFORMERS } from '../plugins/DiffPlugin/__tests__/utils/testConfig';

describe('file editor dirty notifications', () => {
  const source = '---\nupdated: 2026-11-07\n---\n\nOriginal.\n';
  function create() {
    const editor = createTestEditor();
    editor.update(() => $convertFromEnhancedMarkdownString(source, MARKDOWN_TEST_TRANSFORMERS), { discrete: true });
    const dirty = vi.fn();
    const stop = registerMarkdownDirtyListener(editor, MARKDOWN_TEST_TRANSFORMERS, dirty);
    return { editor, dirty, stop };
  }

  it('does not schedule an autosave for repeated viewing/selection/node metadata updates', () => {
    const { editor, dirty } = create();
    for (let i = 0; i < 3; i++) editor.update(() => {
      $getRoot().getFirstChild()!.selectStart();
      // Lexical marks the node dirty even though this has no Markdown change.
      $getRoot().getFirstChild()!.getWritable();
    }, { discrete: true });
    expect(dirty).not.toHaveBeenCalled();
    expect(editor.read(() => $convertToEnhancedMarkdownString(MARKDOWN_TEST_TRANSFORMERS, { preserveSource: preserveMarkdownSource }))).toBe(source);
  });

  it('schedules the first actual edit, without waiting for an unrelated initial update', () => {
    const { editor, dirty, stop } = create();
    editor.update(() => $getRoot().getAllTextNodes()[0].setTextContent('Changed.'), { discrete: true });
    expect(dirty).toHaveBeenCalledTimes(1);
    stop();
    editor.update(() => $getRoot().getAllTextNodes()[0].setTextContent('After unmount.'), { discrete: true });
    expect(dirty).toHaveBeenCalledTimes(1);
  });

  it('accepts an external replacement as the baseline without writing it back', () => {
    const { editor, dirty } = create();
    const external = source.replace('Original.', 'External.');
    editor.update(() => $convertFromEnhancedMarkdownString(external, MARKDOWN_TEST_TRANSFORMERS), { discrete: true, tag: EXTERNAL_CONTENT_UPDATE_TAG });
    editor.update(() => $getRoot().getFirstChild()!.getWritable(), { discrete: true });
    expect(dirty).not.toHaveBeenCalled();
    editor.update(() => $getRoot().getAllTextNodes()[0].setTextContent('Local.'), { discrete: true });
    expect(dirty).toHaveBeenCalledTimes(1);
    expect(editor.read(() => $convertToEnhancedMarkdownString(MARKDOWN_TEST_TRANSFORMERS, { preserveSource: preserveMarkdownSource }))).toBe(external.replace('External.', 'Local.'));
  });
});
