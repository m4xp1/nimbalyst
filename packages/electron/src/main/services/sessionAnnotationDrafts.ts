import { BrowserWindow } from 'electron';
import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import { mergeChatAnnotationChanges, readChatAnnotations, type ChatAnnotation } from '@nimbalyst/runtime/ai/chatAnnotations';
import { database } from '../database/PGLiteDatabaseWorker';
import { parseJsonObjectColumn } from '../utils/jsonColumn';

const writes = new Map<string, Promise<ChatAnnotation[]>>();

/** Serialize annotation patches per session without loading its transcript. */
export function saveSessionAnnotationDraft(sessionId: string, value: unknown, base?: unknown): Promise<ChatAnnotation[]> {
  const pending = (writes.get(sessionId) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const { rows } = await database.query<{ metadata: unknown }>('SELECT metadata FROM ai_sessions WHERE id = $1', [sessionId]);
    if (!rows.length) throw new Error('Session not found');
    const current = readChatAnnotations(parseJsonObjectColumn(rows[0].metadata).draftAnnotations);
    const annotations = base === undefined
      ? readChatAnnotations(value)
      : mergeChatAnnotationChanges(current, readChatAnnotations(base), readChatAnnotations(value));
    await AISessionsRepository.updateMetadata(sessionId, { metadata: { draftAnnotations: annotations } });
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('sessions:session-updated', sessionId, { metadata: { draftAnnotations: annotations } });
    }
    return annotations;
  });
  writes.set(sessionId, pending);
  const clear = () => { if (writes.get(sessionId) === pending) writes.delete(sessionId); };
  void pending.then(clear, clear);
  return pending;
}
