import type { ChatAnnotationSource } from '../../../ai/chatAnnotations';
import type { TranscriptViewMessage } from '../../../ai/server/transcript/TranscriptProjector';

/** Binary lookup over canonical replay order. Never search message bodies or ephemeral IDs. */
export function transcriptAnnotationLocation(messages: readonly TranscriptViewMessage[], source: ChatAnnotationSource) {
  if (source.type !== 'message' || source.messageSequence === undefined) return null;
  const indexOf = (sequence: number) => {
    let low = 0, high = messages.length - 1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      const current = messages[middle].sequence;
      if (current === sequence) return middle;
      if (current < sequence) low = middle + 1;
      else high = middle - 1;
    }
    return -1;
  };
  const startIndex = indexOf(source.messageSequence);
  const endIndex = indexOf(source.endMessageSequence ?? source.messageSequence);
  return startIndex >= 0 && endIndex >= startIndex ? { startIndex, endIndex } : null;
}
