import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MarkdownEditorProps } from '@nimbalyst/runtime/editors';

const capture = vi.hoisted(() => ({ props: null as MarkdownEditorProps | null }));
vi.mock('@nimbalyst/runtime/editors', () => ({
  MarkdownEditor: (props: MarkdownEditorProps) => { capture.props = props; return null; },
}));
import { NimbalystMarkdownEditor } from '../NimbalystMarkdownEditor';

const host = { readOnly: false, filePath: '/synthetic/cards/example.md' } as MarkdownEditorProps['host'];
const collaboration = { shouldBootstrap: false, providerFactory: vi.fn() } satisfies MarkdownEditorProps['collaborationConfig'];
afterEach(() => { cleanup(); capture.props = null; });

describe('Electron Markdown editor used by canvas file fallback and extensions', () => {
  it('preserves unrelated YAML, tables and line endings when saving a file edit', () => {
    render(<NimbalystMarkdownEditor host={host} />);
    const preserve = capture.props?.config?.preserveMarkdownSource;
    expect(preserve).toBeTypeOf('function');
    const raw = '---\r\nupdated: 2026-11-07\r\n---\r\n\r\nOriginal.\r\n\r\n| Name    | Value |\r\n| :------ | ----: |\r\n| alpha   | 12    |\r\n';
    const canonical = '---\nupdated: 2026-11-07T00:00:00.000Z\n---\n\nOriginal.\n\n| Name | Value |\n| :--- | ---: |\n| alpha | 12 |';
    expect(preserve!(raw, canonical, canonical)).toBe(raw);
    expect(preserve!(raw, canonical, canonical.replace('Original.', 'Edited.'))).toBe(raw.replace('Original.', 'Edited.'));
  });

  it('keeps team collaboration canonical while personal sync still preserves disk source', () => {
    const { rerender } = render(<NimbalystMarkdownEditor host={host} collaborationConfig={collaboration} />);
    expect(capture.props?.config?.preserveMarkdownSource).toBeUndefined();
    rerender(<NimbalystMarkdownEditor host={host} collaborationConfig={{ ...collaboration, personalSync: true }} />);
    expect(capture.props?.config?.preserveMarkdownSource).toBeTypeOf('function');
  });

  it('retains an explicit extension source writer', () => {
    const preserve = vi.fn(() => 'extension-owned');
    render(<NimbalystMarkdownEditor host={host} config={{ preserveMarkdownSource: preserve }} />);
    expect(capture.props?.config?.preserveMarkdownSource).toBe(preserve);
  });
});
