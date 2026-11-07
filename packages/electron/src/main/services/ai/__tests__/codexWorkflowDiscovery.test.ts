// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { CodexWorkflowDiscovery } from '../codexWorkflowDiscovery';

describe('CodexWorkflowDiscovery', () => {
  it('exports skills before discovery and shares only concurrent requests in the same workspace', async () => {
    let complete!: (skills: string[]) => void;
    const exportSkills = vi.fn(async () => {});
    const readSkills = vi.fn((_workspace: string) => new Promise<string[]>((resolve) => { complete = resolve; }));
    const catalog = new CodexWorkflowDiscovery(exportSkills, readSkills);
    const first = catalog.get('/worktree');
    const second = catalog.get('/worktree');
    await vi.waitFor(() => expect(readSkills).toHaveBeenCalledTimes(1));
    expect(exportSkills.mock.invocationCallOrder[0]).toBeLessThan(readSkills.mock.invocationCallOrder[0]);
    complete(['plugin:enabled']);
    expect(await first).toEqual(['plugin:enabled']);
    expect(await second).toEqual(['plugin:enabled']);
    readSkills.mockResolvedValueOnce(['plugin:replacement']);
    // A later opening must see installs/uninstalls/config changes, not the old cache.
    expect(await catalog.get('/worktree')).toEqual(['plugin:replacement']);
    expect(readSkills).toHaveBeenCalledTimes(2);
  });

  it('isolates worktree sources and retries failures instead of caching an empty success', async () => {
    const readSkills = vi.fn(async (workspace: string) => [workspace]);
    const catalog = new CodexWorkflowDiscovery(async () => {}, readSkills);
    expect(await Promise.all([catalog.get('/project'), catalog.get('/worktree')])).toEqual([['/project'], ['/worktree']]);
    readSkills.mockRejectedValueOnce(new Error('unavailable'));
    await expect(catalog.get('/project')).rejects.toThrow('unavailable');
    expect(await catalog.get('/project')).toEqual(['/project']);
  });
});
