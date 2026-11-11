export type ChatAnnotationSource =
  | { type: 'file'; filePath: string }
  | { type: 'message'; sessionId: string; messageId: string };

export interface ChatAnnotation {
  id: string;
  source: ChatAnnotationSource;
  quote: string;
  before: string;
  after: string;
  comment: string;
}

export function readChatAnnotations(value: unknown): ChatAnnotation[] {
  if (!Array.isArray(value)) return [];
  return value.filter((annotation): annotation is ChatAnnotation => {
    if (!annotation || typeof annotation !== 'object') return false;
    const { id, source, quote, before, after, comment } = annotation;
    if (![id, quote, before, after, comment].every(field => typeof field === 'string')) return false;
    return source?.type === 'file'
      ? typeof source.filePath === 'string'
      : source?.type === 'message' && typeof source.sessionId === 'string' && typeof source.messageId === 'string';
  });
}

export function chatAnnotationSourceLabel(source: ChatAnnotationSource): string {
  return source.type === 'file' ? source.filePath : `Chat message ${source.messageId}`;
}

export function appendChatAnnotations(prompt: string, annotations: readonly ChatAnnotation[]): string {
  if (!annotations.length) return prompt;
  const quoted = annotations.map((annotation, index) => {
    const quote = annotation.quote.split('\n').map(line => '> ' + line).join('\n');
    return `${index + 1}. ${chatAnnotationSourceLabel(annotation.source)}\n${quote}${
      annotation.comment ? '\n\nComment: ' + annotation.comment : ''
    }`;
  });
  return [prompt, 'Annotations attached by the user', ...quoted].join('\n\n');
}

/** Keep the quote when a source changes. Restore a marker only for an unambiguous location. */
export function findChatAnnotationOffset(
  text: string,
  { quote, before, after }: Pick<ChatAnnotation, 'quote' | 'before' | 'after'>,
): number | null {
  if (!quote) return null;
  const candidates: number[] = [];
  const withContext: number[] = [];
  for (let offset = text.indexOf(quote); offset >= 0; offset = text.indexOf(quote, offset + 1)) {
    candidates.push(offset);
    if (text.slice(0, offset).endsWith(before) && text.startsWith(after, offset + quote.length)) {
      withContext.push(offset);
    }
  }
  if (candidates.length === 1) return candidates[0];
  return withContext.length === 1 ? withContext[0] : null;
}
