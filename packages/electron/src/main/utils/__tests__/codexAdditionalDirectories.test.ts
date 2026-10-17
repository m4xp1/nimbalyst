// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { loadCodexAdditionalDirectories } from '../codexAdditionalDirectories';

describe('Codex Additional Directories settings bridge', () => {
  it('merges effective settings with automatic roots without attaching permission-only folders', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'codex-settings-roots-'));
    try {
      const automatic = path.join(root, 'attached'), configured = path.join(root, 'permissions-only');
      mkdirSync(automatic); mkdirSync(configured);
      const read = vi.fn(async () => ({ permissions: { additionalDirectories: [configured, automatic + path.sep] } }));
      expect(await loadCodexAdditionalDirectories(root, [automatic], read)).toEqual([realpathSync.native(automatic), realpathSync.native(configured)]);
      expect(read).toHaveBeenCalledWith(root);
      expect(await loadCodexAdditionalDirectories(root, [automatic], async () => ({ permissions: {} }))).toEqual([realpathSync.native(automatic)]);
      expect(await loadCodexAdditionalDirectories(root, [configured], read)).toEqual([realpathSync.native(configured), realpathSync.native(automatic)]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('reports invalid explicit paths and settings errors instead of silently widening access', async () => {
    await expect(loadCodexAdditionalDirectories(process.cwd(), [], async () => { throw Error('settings unavailable'); })).rejects.toThrow('settings unavailable');
    await expect(loadCodexAdditionalDirectories(process.cwd(), [], async () => ({ permissions: { additionalDirectories: ['\0'] } }))).rejects.toThrow('Invalid Codex');
    await expect(loadCodexAdditionalDirectories(process.cwd(), [], async () => ({ permissions: { additionalDirectories: ['missing-codex-fixture-directory'] } }))).rejects.toThrow('Cannot use Codex');
  });
});
