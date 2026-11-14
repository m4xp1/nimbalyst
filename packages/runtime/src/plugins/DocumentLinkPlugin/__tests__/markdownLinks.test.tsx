import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LinkNode } from '@lexical/link';
import { HeadingNode } from '@lexical/rich-text';
import { $convertFromMarkdownString } from '@lexical/markdown';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { ClickableLinkPlugin } from '@lexical/react/LexicalClickableLinkPlugin';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DocumentService } from '../../../core/DocumentService';
import { CORE_TRANSFORMERS } from '../../../editor/markdown/core-transformers';
import { DocumentLinkPlugin } from '../index';

function TypeaheadStub(): null {
  return null;
}

const TUTORIAL_README_TAIL =
  'Use this workspace as a reference.\n\n[Open the project manager](nimbalyst://action/open-project-manager)\n';

function renderMarkdown(
  markdown: string,
  documentService: Partial<DocumentService> = {},
) {
  return render(
    <LexicalComposer
      initialConfig={{
        namespace: 'document-link-action-markdown-test',
        nodes: [LinkNode, HeadingNode],
        onError: (error) => {
          throw error;
        },
        editorState: () => {
          $convertFromMarkdownString(markdown, CORE_TRANSFORMERS);
        },
      }}
    >
      <RichTextPlugin
        contentEditable={<ContentEditable />}
        placeholder={null}
        ErrorBoundary={LexicalErrorBoundary}
      />
      {/* The real editor ships ClickableLinkPlugin; its window.open is what
          sends an unhandled action link out to the OS / default browser. */}
      <ClickableLinkPlugin />
      <DocumentLinkPlugin
        documentService={documentService as DocumentService}
        TypeaheadMenuPlugin={TypeaheadStub}
        triggerFn={() => null}
      />
    </LexicalComposer>,
  );
}

describe('workspace file links imported from markdown', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opens only the file path and carries the decoded heading through the document service', async () => {
    vi.stubGlobal('__workspacePath', '/workspace');
    const openDocument = vi.fn().mockResolvedValue(undefined);
    const getDocumentByPath = vi.fn().mockResolvedValue(null);
    renderMarkdown('[Section](docs/a%23b.md#Требование%20языка)\n', { openDocument, getDocumentByPath });
    fireEvent.click(await screen.findByRole('link', { name: 'Section' }));
    await waitFor(() => expect(openDocument).toHaveBeenCalledWith('', { path: 'docs/a#b.md', fragment: 'Требование языка', name: undefined }));
    expect(getDocumentByPath).toHaveBeenCalledWith('docs/a#b.md');
  });

  it('scrolls an in-document heading without reopening the file', async () => {
    const openDocument = vi.fn();
    renderMarkdown('[Jump](#требование-языка)\n\n## Требование языка\n', { openDocument });
    const heading = await screen.findByRole('heading', { name: 'Требование языка' });
    heading.scrollIntoView = vi.fn();
    fireEvent.click(await screen.findByRole('link', { name: 'Jump' }));
    expect(heading.scrollIntoView).toHaveBeenCalledWith({ block: 'start', behavior: 'smooth' });
    expect(openDocument).not.toHaveBeenCalled();
  });

  // Lexical's `formatUrl` rewrites a bare relative path (no leading `./`) to
  // `https://<path>` when it builds the anchor, which made the renderer's
  // external-link handler open the user's browser instead of the file.
  it('keeps a bare relative path in the rendered href', async () => {
    renderMarkdown('Open the [dashboard mockup](design/dashboard.mockup.html).\n');

    const link = await waitFor(() =>
      screen.getByRole('link', { name: 'dashboard mockup' }),
    );

    expect(link.getAttribute('href')).toBe('design/dashboard.mockup.html');
  });

  it('keeps a dot-relative path in the rendered href', async () => {
    renderMarkdown('See the [revenue data](../data/revenue.csv).\n');

    const link = await waitFor(() =>
      screen.getByRole('link', { name: 'revenue data' }),
    );

    expect(link.getAttribute('href')).toBe('../data/revenue.csv');
  });

  it('opens the workspace file instead of letting the link navigate', async () => {
    const openDocument = vi.fn().mockResolvedValue(undefined);
    const getDocumentByPath = vi.fn().mockResolvedValue(null);
    const open = vi.fn();
    vi.stubGlobal('open', open);

    renderMarkdown('Open the [dashboard mockup](design/dashboard.mockup.html).\n', {
      openDocument,
      getDocumentByPath,
    });

    const link = await waitFor(() =>
      screen.getByRole('link', { name: 'dashboard mockup' }),
    );
    fireEvent.click(link);

    await waitFor(() => expect(openDocument).toHaveBeenCalled());
    expect(openDocument.mock.calls[0][1]).toMatchObject({
      path: 'design/dashboard.mockup.html',
    });
    expect(open).not.toHaveBeenCalled();
  });

  it('leaves real web links alone', async () => {
    renderMarkdown('Read the [docs](https://docs.nimbalyst.com/).\n');

    const link = await waitFor(() => screen.getByRole('link', { name: 'docs' }));

    expect(link.getAttribute('href')).toBe('https://docs.nimbalyst.com/');
  });
});

describe('app action links imported from markdown', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('dispatches the action instead of letting ClickableLinkPlugin open a window', async () => {
    const send = vi.fn();
    const open = vi.fn();
    vi.stubGlobal('electronAPI', { send });
    vi.stubGlobal('open', open);

    renderMarkdown(TUTORIAL_README_TAIL);

    const link = await waitFor(() =>
      screen.getByRole('link', { name: 'Open the project manager' }),
    );

    fireEvent.click(link);

    expect(send).toHaveBeenCalledWith(
      'app-action:dispatch',
      'nimbalyst://action/open-project-manager',
    );
    expect(open).not.toHaveBeenCalled();
  });
});
