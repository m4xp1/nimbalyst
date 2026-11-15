// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { ChatAnnotationSource } from '@nimbalyst/runtime/ai/chatAnnotations';
import type { TranscriptViewMessage } from '@nimbalyst/runtime/ai/server/transcript/TranscriptProjector';
import { transcriptAnnotationLocation } from '@nimbalyst/runtime/ui/AgentTranscript/utils/transcriptAnnotationLocation';

const message = (id: number, sequence: number): TranscriptViewMessage => ({
  id, sequence, createdAt: new Date(1700000000000 + sequence), type: 'assistant_message', subagentId: null,
  get text(): string { throw new Error('Unexpected full-text scan'); },
});
const source: Extract<ChatAnnotationSource, { type: 'message' }> = { type: 'message', sessionId: 's', messageId: '1', messageSequence: 8 };

describe('persisted transcript annotation locations', () => {
  it('finds the same message after runtime IDs are reallocated on reload', () => {
    expect(transcriptAnnotationLocation([message(1, 0), message(409, 8)], source))
      .toEqual({ startIndex: 1, endIndex: 1 });
  });
  it('restores both endpoints without scanning the quote or history text', () => {
    expect(transcriptAnnotationLocation([message(1, 0), message(409, 8), message(410, 12)],
      { ...source, endMessageId: '7', endMessageSequence: 12 }))
      .toEqual({ startIndex: 1, endIndex: 2 });
  });
  it('does not recover legacy IDs or fabricate a missing location', () => {
    const messages = [message(1, 0), message(409, 8)];
    expect(transcriptAnnotationLocation(messages, { type: 'message', sessionId: 's', messageId: '1' })).toBeNull();
    expect(transcriptAnnotationLocation(messages, { ...source, messageSequence: 3 })).toBeNull();
    expect(transcriptAnnotationLocation(messages, { ...source, endMessageSequence: 10 })).toBeNull();
    expect(transcriptAnnotationLocation(messages, { ...source, endMessageSequence: 0 })).toBeNull();
  });
  it('bounds lookup work logarithmically even in a large transcript', () => {
    let reads = 0;
    const messages = Array.from({ length: 65536 }, (_, index) => {
      const value = message(index + 100000, index);
      Object.defineProperty(value, 'sequence', { get() { reads++; return index; } });
      return value;
    });
    expect(transcriptAnnotationLocation(messages, { ...source, messageSequence: 60000 })).toEqual({ startIndex: 60000, endIndex: 60000 });
    expect(reads).toBeLessThan(40);
  });
});
