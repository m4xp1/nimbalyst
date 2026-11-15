import { appendChatAnnotations, readChatAnnotations, type ChatAnnotation } from './chatAnnotations';
import type { ChatAttachment } from './server/types';
import type { EditorContextItem } from '@nimbalyst/extension-sdk/types/editor';
import type { MockupSelection } from '../mockup/types';

/** User-visible context only. Execution/account settings never cross this boundary. */
export interface MessageDocumentContext {
  filePath?: string;
  fileName?: string;
  fileType?: string;
  content?: string;
  textSelection?: { text: string; filePath: string; timestamp: number };
  textSelectionTimestamp?: number;
  editorContextItems?: EditorContextItem[];
  mockupSelection?: MockupSelection;
  mockupDrawing?: string;
}

export interface MessageDraftContext {
  document?: MessageDocumentContext;
  selection?: ChatAnnotation;
}

export interface ClipboardMessage {
  version: 1;
  text: string;
  annotations?: ChatAnnotation[];
  context?: MessageDraftContext;
  attachments?: ChatAttachment[];
}

const MAX_CLIPBOARD_LENGTH = 16 * 1024 * 1024;
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function readMessageDraftContext(value: unknown): MessageDraftContext | undefined {
  const source = record(value);
  if (!source) return undefined;
  const result: MessageDraftContext = {};
  const selection = readChatAnnotations([source.selection])[0];
  if (selection) result.selection = selection;
  const doc = record(source.document);
  if (doc) {
    const document: MessageDocumentContext = {};
    for (const key of ['filePath', 'fileName', 'fileType', 'content', 'mockupDrawing'] as const) {
      if (typeof doc[key] === 'string') document[key] = doc[key];
    }
    const text = record(doc.textSelection);
    if (text && typeof text.text === 'string' && typeof text.filePath === 'string') {
      document.textSelection = { text: text.text, filePath: text.filePath, timestamp: typeof text.timestamp === 'number' ? text.timestamp : 0 };
    }
    if (typeof doc.textSelectionTimestamp === 'number') document.textSelectionTimestamp = doc.textSelectionTimestamp;
    const mockup = record(doc.mockupSelection);
    if (mockup && typeof mockup.selector === 'string' && typeof mockup.outerHTML === 'string' && typeof mockup.tagName === 'string') {
      document.mockupSelection = { selector: mockup.selector, outerHTML: mockup.outerHTML, tagName: mockup.tagName };
    }
    if (Array.isArray(doc.editorContextItems)) {
      document.editorContextItems = doc.editorContextItems.flatMap(value => {
        const item = record(value);
        if (!item || typeof item.id !== 'string' || typeof item.label !== 'string' || typeof item.description !== 'string') return [];
        const clean: EditorContextItem = { id: item.id, label: item.label, description: item.description };
        for (const key of ['icon', 'groupLabel'] as const) if (typeof item[key] === 'string') clean[key] = item[key];
        if (typeof item.includeData === 'boolean') clean.includeData = item.includeData;
        try {
          const json = JSON.stringify(item.data);
          if (json && json.length <= 32768) clean.data = JSON.parse(json);
        } catch { /* Non-JSON editor state is not portable. */ }
        return [clean];
      });
    }
    if (Object.keys(document).length) result.document = document;
  }
  return Object.keys(result).length ? result : undefined;
}

export function readClipboardMessage(value: unknown): ClipboardMessage | null {
  const input = record(value);
  if (input?.version !== 1 || typeof input.text !== 'string') return null;
  const result: ClipboardMessage = { version: 1, text: input.text };
  const annotations = readChatAnnotations(input.annotations);
  if (annotations.length) result.annotations = annotations;
  const context = readMessageDraftContext(input.context);
  if (context) result.context = context;
  if (Array.isArray(input.attachments)) {
    result.attachments = input.attachments.flatMap(value => {
      const a = record(value);
      if (!a || typeof a.id !== 'string' || typeof a.filepath !== 'string' || typeof a.filename !== 'string' ||
          typeof a.mimeType !== 'string' || typeof a.size !== 'number' || !['image', 'pdf', 'document'].includes(a.type as string)) return [];
      return [{ id: a.id, filename: a.filename, filepath: a.filepath, mimeType: a.mimeType, size: a.size,
        type: a.type as ChatAttachment['type'], addedAt: typeof a.addedAt === 'number' ? a.addedAt : 0,
        ...(typeof a.thumbnail === 'string' ? { thumbnail: a.thumbnail } : {}) }];
    });
  }
  return result;
}

function plainText(message: ClipboardMessage): string {
  let text = appendChatAnnotations(message.text, message.annotations ?? []);
  if (message.context?.selection) text += '\n\nSelection: ' + message.context.selection.quote;
  const doc = message.context?.document;
  if (doc?.filePath) text += '\n\nContext: ' + doc.filePath;
  if (doc?.textSelection) text += '\nSelection: ' + doc.textSelection.text;
  for (const item of doc?.editorContextItems ?? []) text += '\n' + item.label + ': ' + item.description;
  if (doc?.mockupSelection) text += '\nSelected element: ' + doc.mockupSelection.outerHTML;
  if (doc?.mockupDrawing) text += '\n[Mockup drawing attached]';
  for (const attachment of message.attachments ?? []) text += '\n\nAttachment: ' + attachment.filepath;
  return text;
}

/** Steering has no separate document channel, so carry the same visible context inline. */
export function appendMessageDocumentContext(prompt: string, context?: MessageDraftContext): string {
  const document = context?.document;
  if (!document) return prompt;
  let result = prompt;
  if (document.filePath) result += '\n\nContext file: ' + document.filePath;
  if (document.textSelection) result += '\nSelected text: ' + document.textSelection.text;
  for (const item of document.editorContextItems ?? []) {
    result += '\n' + item.label + ': ' + item.description;
    if (item.includeData && item.data !== undefined) result += '\n' + JSON.stringify(item.data);
  }
  if (document.mockupSelection) result += '\nSelected element: ' + document.mockupSelection.outerHTML;
  if (document.mockupDrawing) result += '\nMockup drawing: ' + document.mockupDrawing;
  if (document.content) result += '\n\nDocument content:\n' + document.content;
  return result;
}

export function encodeMessageClipboard(input: ClipboardMessage): { text: string; html: string } {
  const message = readClipboardMessage(input);
  if (!message) throw new Error('Invalid message clipboard data');
  const encoded = encodeURIComponent(JSON.stringify(message)).replace(/'/g, '%27');
  if (encoded.length > MAX_CLIPBOARD_LENGTH) throw new Error('Message context is too large to copy');
  const text = plainText(message);
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return { text, html: '<div data-nimbalyst-message="' + encoded + '"><pre>' + escaped + '</pre></div>' };
}

/** HTML is parsed as data only; it is never rendered or executed. */
export function decodeMessageClipboard(html: string, text: string): ClipboardMessage | null {
  if (!html || html.length > MAX_CLIPBOARD_LENGTH * 2) return null;
  const encoded = /data-nimbalyst-message="([^"]+)"/.exec(html)?.[1];
  if (!encoded || encoded.length > MAX_CLIPBOARD_LENGTH) return null;
  try {
    const message = readClipboardMessage(JSON.parse(decodeURIComponent(encoded)));
    // Prevent stale metadata from being applied to a subsequently edited clipboard.
    return message && plainText(message).replace(/\r\n/g, '\n') === text.replace(/\r\n/g, '\n') ? message : null;
  } catch { return null; }
}
