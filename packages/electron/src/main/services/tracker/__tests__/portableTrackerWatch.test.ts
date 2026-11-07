// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
vi.mock('../../../file/WorkspaceEventBus', () => ({}));
import type { WorkspaceEventListener } from '../../../file/WorkspaceEventBus';
import { createPortableTrackerWatch } from '../portableTrackerWatch';

afterEach(() => { vi.useRealTimers(); });
function harness() {
  let listener: WorkspaceEventListener;
  const bus = { subscribe: vi.fn(async (_workspace: string, _id: string, value: WorkspaceEventListener) => { listener = value; }), unsubscribe: vi.fn(), addGitignoreBypass: vi.fn(), removeGitignoreBypass: vi.fn() };
  const workspace = path.resolve('synthetic-workspace');
  const file = (id = 'card-one') => path.join(workspace, '.nimbalyst', 'tracker-comments', `${id}.jsonl`);
  return { bus, workspace, file, event: () => listener! };
}
describe('portable tracker sidecar subscription', () => {
  it('coalesces only this workspace comment paths and unregisters exact ignore bypasses', async () => {
    vi.useFakeTimers();
    const h = harness(), changed = vi.fn(async (_id: string, _isCurrent: () => boolean) => {}), error = vi.fn();
    const watch = await createPortableTrackerWatch(h.workspace, changed, error, h.bus);
    watch.track('card-one'); watch.track('card-one');
    expect(h.bus.addGitignoreBypass).toHaveBeenCalledTimes(1);
    h.event().onAdd(h.file()); h.event().onChange(h.file()); h.event().onUnlink(h.file());
    h.event().onChange(path.join(h.workspace, 'docs', 'not-sidecar.jsonl'));
    h.event().onChange(path.join(h.workspace, '..', 'other', '.nimbalyst', 'tracker-comments', 'card-two.jsonl'));
    await vi.advanceTimersByTimeAsync(50);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed.mock.calls[0][0]).toBe('card-one');
    await vi.advanceTimersByTimeAsync(10000); expect(changed).toHaveBeenCalledTimes(1);
    h.event().onChange(h.file('card-two')); watch.dispose();
    await vi.advanceTimersByTimeAsync(100); expect(changed).toHaveBeenCalledTimes(1);
    expect(h.bus.removeGitignoreBypass).toHaveBeenCalledWith(h.workspace, h.file(), expect.any(String));
    expect(h.bus.unsubscribe).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
  });
  it('serializes in-flight callbacks, queues the latest event and rejects late publication after dispose', async () => {
    vi.useFakeTimers();
    const h = harness(); let finish!: () => void;
    const current: Array<() => boolean> = [];
    const changed = vi.fn(async (_id: string, isCurrent: () => boolean) => { current.push(isCurrent); if (current.length === 1) await new Promise<void>(resolve => { finish = resolve; }); });
    const watch = await createPortableTrackerWatch(h.workspace, changed, vi.fn(), h.bus);
    h.event().onChange(h.file()); await vi.advanceTimersByTimeAsync(50);
    h.event().onChange(h.file()); h.event().onChange(h.file());
    await vi.advanceTimersByTimeAsync(200); expect(changed).toHaveBeenCalledTimes(1);
    finish(); await vi.advanceTimersByTimeAsync(50); expect(changed).toHaveBeenCalledTimes(2);
    expect(current[0]()).toBe(true); watch.dispose(); expect(current[0]()).toBe(false);
  });
  it('reports a bad sidecar without dropping changes for other cards', async () => {
    vi.useFakeTimers(); const h = harness(), error = vi.fn();
    const changed = vi.fn(async (id: string) => { if (id === 'card-one') throw new Error('Invalid JSONL'); });
    const watch = await createPortableTrackerWatch(h.workspace, changed, error, h.bus);
    h.event().onChange(h.file()); h.event().onChange(h.file('card-two'));
    await vi.advanceTimersByTimeAsync(50);
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ message: 'Invalid JSONL' }), 'card-one');
    expect(changed).toHaveBeenCalledTimes(2); watch.dispose();
  });
});
