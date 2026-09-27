// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { EditorHost } from '@nimbalyst/runtime';
import { TrackerFileBackedPreview } from '../TrackerFileBackedPreview';

let previewHost: EditorHost | undefined;
let previewConfig: { editable?: boolean; showToolbar?: boolean } | undefined;

vi.mock('@nimbalyst/runtime/editors', () => ({
  MarkdownEditor: ({ host, config }: { host: EditorHost; config: typeof previewConfig }) => {
    previewHost = host;
    previewConfig = config;
    return <div data-testid="markdown-preview-editor" />;
  },
}));
vi.mock('../../../hooks/useTheme', () => ({ useTheme: () => ({ theme: 'light' }) }));

describe('TrackerFileBackedPreview', () => {
  it('loads the supplied Markdown in a read-only editor', async () => {
    render(<TrackerFileBackedPreview filePath="C:\\ws\\plans\\example.md" content="# Plan" />);

    screen.getByTestId('tracker-file-backed-document-preview');
    expect(previewConfig).toMatchObject({ editable: false, showToolbar: false });
    expect(previewHost?.fileName).toBe('example.md');
    expect(await previewHost?.loadContent()).toBe('# Plan');
  });
});
