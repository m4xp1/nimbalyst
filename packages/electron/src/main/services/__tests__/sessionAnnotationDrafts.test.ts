// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ query: vi.fn(), write: vi.fn(), send: vi.fn(), metadata: {} as Record<string, unknown> }));
vi.mock('../../database/PGLiteDatabaseWorker', () => ({ database: { query: f.query } }));
vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({ AISessionsRepository: { updateMetadata: f.write } }));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: f.send } }] } }));
import { saveSessionAnnotationDraft } from '../sessionAnnotationDrafts';

function note(id: string, comment: string) {
  return { id, comment, quote: id, before: '', after: '', source: { type: 'file' as const, filePath: '/synthetic/notes.md' } };
}

beforeEach(() => {
  f.metadata = { draftAnnotations: [], phase: 'planning' };
  f.query.mockReset().mockImplementation(async () => ({ rows: [{ metadata: JSON.stringify(f.metadata) }] }));
  f.write.mockReset().mockImplementation(async (_id, update) => { Object.assign(f.metadata, update.metadata); });
  f.send.mockClear();
});

it('merges concurrent windows against the latest persisted snapshot without loading the transcript', async () => {
  await Promise.all([
    saveSessionAnnotationDraft('session', [note('a', 'First window')], []),
    saveSessionAnnotationDraft('session', [note('b', 'Second window')], []),
  ]);
  expect(f.metadata).toEqual({ draftAnnotations: [note('a', 'First window'), note('b', 'Second window')], phase: 'planning' });
  expect(f.query.mock.calls).toEqual([
    ['SELECT metadata FROM ai_sessions WHERE id = $1', ['session']],
    ['SELECT metadata FROM ai_sessions WHERE id = $1', ['session']],
  ]);
  expect(f.send).toHaveBeenLastCalledWith('sessions:session-updated', 'session', {
    metadata: { draftAnnotations: [note('a', 'First window'), note('b', 'Second window')] },
  });
});

it('applies a deletion without dropping a note created by another window', async () => {
  f.metadata.draftAnnotations = [note('a', 'Old'), note('b', 'Remote')];
  f.query.mockImplementation(async () => ({ rows: [{ metadata: f.metadata }] }));
  await saveSessionAnnotationDraft('session', [], [note('a', 'Old')]);
  expect(f.metadata.draftAnnotations).toEqual([note('b', 'Remote')]);
});

it('does not broadcast a failed write and accepts a retry', async () => {
  f.write.mockRejectedValueOnce(new Error('Synthetic write failure'));
  await expect(saveSessionAnnotationDraft('session', [note('a', 'Retry')], [])).rejects.toThrow('Synthetic write failure');
  expect(f.send).not.toHaveBeenCalled();
  await saveSessionAnnotationDraft('session', [note('a', 'Retry')], []);
  expect(f.metadata.draftAnnotations).toEqual([note('a', 'Retry')]);
});
