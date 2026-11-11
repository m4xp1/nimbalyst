// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { appendChatAnnotations, findChatAnnotationOffset, readChatAnnotations, type ChatAnnotation } from '../chatAnnotations';

const annotation: ChatAnnotation = {
  id: 'annotation-1',
  source: { type: 'file', filePath: '/workspace/notes.md' },
  quote: 'repeated',
  before: 'Second ',
  after: ' phrase.',
  comment: 'Use this evidence.',
};

describe('chat annotation anchors', () => {
  it('uses surrounding text to choose the right duplicate after edits shift its offset', () => {
    const text = 'Inserted heading. First repeated phrase. Second repeated phrase.';
    expect(findChatAnnotationOffset(text, annotation)).toBe(text.lastIndexOf(annotation.quote));
  });

  it.each([
    'First changed phrase. Second changed phrase.',
    'Second repeated phrase. Second repeated phrase.',
    'First repeated phrase. Third repeated phrase.',
  ])('does not attach a marker to ambiguous or edited text %j', text => {
    expect(findChatAnnotationOffset(text, annotation)).toBeNull();
  });

  it('keeps the selected quote and comment usable after the source becomes unavailable', () => {
    const saved = { ...annotation, quote: 'First line\nSecond line' };
    const hydrated = readChatAnnotations([saved, { ...saved, source: { type: 'message' } }, null]);
    expect(hydrated).toEqual([saved]);
    expect(appendChatAnnotations('Explain the annotation.', hydrated)).toContain(
      '1. /workspace/notes.md\n> First line\n> Second line\n\nComment: Use this evidence.',
    );
  });
});
