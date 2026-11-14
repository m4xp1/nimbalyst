// @vitest-environment node
import { expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ windows: [] as any[] }));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => f.windows } }));
vi.mock('../../../utils/logger', () => ({ logger: { main: { warn: vi.fn() } } }));
import { broadcastSessionTokenUsage } from '../sessionTokenUsageUpdates';

it('delivers the same measured snapshot to every open view despite a closing window', () => {
  const first = vi.fn(), last = vi.fn();
  f.windows = [
    { isDestroyed: () => false, webContents: { send: first } },
    { isDestroyed: () => false, webContents: { send: () => { throw new Error('closing'); } } },
    { isDestroyed: () => true, webContents: { send: vi.fn() } },
    { isDestroyed: () => false, webContents: { send: last } },
  ];
  const tokenUsage = { inputTokens: 100000, outputTokens: 1000, totalTokens: 101000, currentContext: { tokens: 0, contextWindow: 258400 } };
  broadcastSessionTokenUsage('context-session', tokenUsage);
  for (const send of [first, last]) expect(send).toHaveBeenCalledWith('ai:tokenUsageUpdated', { sessionId: 'context-session', tokenUsage });
});
