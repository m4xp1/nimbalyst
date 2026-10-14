import type { SessionMeta } from '@nimbalyst/runtime';
import { TranscriptMigrationRepository } from '@nimbalyst/runtime/storage/repositories/TranscriptMigrationRepository';

/** One reader for the search projection and live agent reads; never provider JSON. */
export async function readMemorySessionContent(meta: SessionMeta): Promise<{
  text: string; parentSessionId: string | null;
}> {
  const messages = await TranscriptMigrationRepository.getService().getViewMessages(meta.id, meta.provider);
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
