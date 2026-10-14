import type { SessionMeta } from '@nimbalyst/runtime';
import { TranscriptRuntime } from '@nimbalyst/runtime/ai/server/transcript/TranscriptRuntime';
import { createRawMessageStoreAdapter } from './TranscriptMigrationAdapters';

// Same parser/projector, separate derived cache: backfill must not evict open UI sessions.
let runtime:TranscriptRuntime|undefined;
export function invalidateMemorySessionContent(sessionId?:string):void {
  if(sessionId)void runtime?.forceReparseSession(sessionId, '');
  else runtime=undefined;
}

/** One reader for the search projection and live agent reads; never provider JSON. */
export async function readMemorySessionContent(meta: SessionMeta, reader?:Pick<TranscriptRuntime,'getViewMessages'>): Promise<{
  text: string; parentSessionId: string | null;
}> {
  const source=reader??(runtime??=new TranscriptRuntime(createRawMessageStoreAdapter()));
  const messages = await source.getViewMessages(meta.id, meta.provider);
  const text = messages.filter(message =>
    (message.type === 'user_message' || message.type === 'assistant_message') &&
    !message.optimistic && message.promptActor !== 'system' &&
    message.promptOrigin !== 'wakeup_resume' && !!message.text?.trim() &&
    !(message.type === 'user_message' &&
      (message.text.startsWith('[System:') || /<SYSTEM_REMINDER>[\s\S]*<\/SYSTEM_REMINDER>/.test(message.text)))
  ).map(message => `## ${message.type === 'user_message' ? 'User' : 'Assistant'}\n\n${message.text}`)
    .join('\n\n');
  return { text, parentSessionId: meta.parentSessionId ?? null };
}
