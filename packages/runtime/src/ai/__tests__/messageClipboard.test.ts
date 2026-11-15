import { describe, expect, it } from 'vitest';
import { encodeMessageClipboard, decodeMessageClipboard, readMessageDraftContext } from '../messageClipboard';

const annotation = { id: 'a', source: { type: 'message' as const, sessionId: 'source-session', messageId: '42', messageSequence: 12 }, quote: 'Selected text', before: '', after: '', comment: 'Please check' };
const context = {
  document: { filePath: 'C:/project/Notes.md', fileType: 'markdown', content: '# Notes', textSelection: { text: 'Notes', filePath: 'C:/project/Notes.md', timestamp: 1 } },
  selection: { ...annotation, id: 'selection', comment: '' },
};

describe('portable message clipboard', () => {
  it('round trips Unicode, annotations, selection, document context and attachment references', () => {
    const message = { version: 1 as const, text: 'Проверь <script> & "цитату"', annotations: [annotation], context,
      attachments: [{ id: 'image', filename: 'image.png', filepath: 'C:/project/image.png', mimeType: 'image/png', size: 12, type: 'image' as const, addedAt: 1 }] };
    const clipboard = encodeMessageClipboard(message);
    expect(decodeMessageClipboard(clipboard.html, clipboard.text)).toEqual(message);
    expect(clipboard.text).toContain('Please check');
    expect(clipboard.text).toContain('Notes.md');
    expect(clipboard.html).not.toContain('<script>');
  });

  it('treats ordinary, corrupt, stale and unsupported clipboard content as plain text', () => {
    const clipboard = encodeMessageClipboard({ version: 1, text: 'Original', annotations: [annotation] });
    expect(decodeMessageClipboard('<p>Other app</p>', 'Other app')).toBeNull();
    expect(decodeMessageClipboard(clipboard.html, 'Changed text')).toBeNull();
    expect(decodeMessageClipboard('<div data-nimbalyst-message="%zz">', '')).toBeNull();
    expect(decodeMessageClipboard('<div data-nimbalyst-message="' + encodeURIComponent(JSON.stringify({ version: 2, text: 'future' })) + '">', 'future')).toBeNull();
  });

  it('does not import execution, identity or permission settings through clipboard metadata', () => {
    expect(readMessageDraftContext({ ...context, apiKey: 'secret', mode: 'agent', permissionsPath: 'elsewhere',
      document: { ...context.document, editingInstructions: 'unexpected', worktreePath: 'elsewhere' } })).toEqual(context);
  });

  it('keeps editor selections and mockup data as inert context', () => {
    const document = { filePath: 'drawing.mockup.html', mockupSelection: { selector: '#button', tagName: 'BUTTON', outerHTML: '<button>Continue</button>' },
      mockupDrawing: 'data:image/png;base64,AAAA', editorContextItems: [{ id: 'node1', label: 'Node', description: 'Selected node', includeData: true, data: { x: 2 } }] };
    expect(readMessageDraftContext({ document })).toEqual({ document });
  });
});
