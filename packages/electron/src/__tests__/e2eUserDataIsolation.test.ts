// @vitest-environment node
/**
 * Guard: the E2E launcher must never point Electron at the developer's real
 * userData directory.
 *
 * `PLAYWRIGHT=1` only redirects the *database* (see `database/initialize.ts`)
 * and the extensions folder. Everything else `app.getPath('userData')` backs --
 * `app-settings.json`, `workspace-settings.json`, `ai-settings.json`,
 * `terminal-store.json`, `stytch-*.enc` -- resolves to the real directory
 * unless `NIMBALYST_USER_DATA_DIR` is set (see `main/bootstrap.ts`).
 *
 * Because `allowMultipleInstances` is also true under `PLAYWRIGHT`
 * (`main/index.ts`), a test run launches *alongside* the developer's running
 * dev instance and both electron-store instances read-modify-write the same
 * `app-settings.json`. That is how a test run can silently rewrite real
 * settings (sync config, signed-in accounts, open workspaces).
 */

import { describe, it, expect, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { buildTestEnv, resolveTestRendererUrl, buildElectronArgs } from '../../e2e/helpers';

const REAL_USER_DATA_FRAGMENT = path.join('@nimbalyst', 'electron');

describe('E2E launcher userData isolation', () => {
  it('selects the isolated profile before static main-process imports execute', () => {
    const mine = path.join(os.tmpdir(), 'nimbalyst-launch-profile');
    expect(buildElectronArgs('/synthetic/main.js', '/synthetic/workspace', mine))
      .toContain(`--user-data-dir=${mine}`);
    expect(buildElectronArgs(undefined, '/synthetic/workspace', mine))
      .toEqual([`--user-data-dir=${mine}`, '--workspace', '/synthetic/workspace']);
  });
  it('pins Electron at an isolated temp userData directory', () => {
    const env = buildTestEnv('http://127.0.0.1:5273');

    expect(env.NIMBALYST_USER_DATA_DIR).toBeTruthy();
    expect(env.NIMBALYST_USER_DATA_DIR!.startsWith(os.tmpdir())).toBe(true);
    expect(env.NIMBALYST_USER_DATA_DIR).not.toContain(REAL_USER_DATA_FRAGMENT);
  });

  it('lets a spec opt into its own userData directory', () => {
    const mine = path.join(os.tmpdir(), 'nimbalyst-spec-scoped-user-data');
    const env = buildTestEnv('http://127.0.0.1:5273', {
      env: { NIMBALYST_USER_DATA_DIR: mine },
    });

    expect(env.NIMBALYST_USER_DATA_DIR).toBe(mine);
  });

  it('does not inherit a NIMBALYST_USER_DATA_DIR pointing at real user data', () => {
    // A worktree dev shell can export NIMBALYST_USER_DATA_DIR; `buildTestEnv`
    // spreads `process.env`, so the default must win over the inherited value
    // unless the spec asked for a specific directory.
    const previous = process.env.NIMBALYST_USER_DATA_DIR;
    process.env.NIMBALYST_USER_DATA_DIR = path.join(
      os.homedir(),
      'Library',
      'Application Support',
      '@nimbalyst',
      'electron',
    );
    try {
      const env = buildTestEnv('http://127.0.0.1:5273');
      expect(env.NIMBALYST_USER_DATA_DIR).not.toContain(REAL_USER_DATA_FRAGMENT);
    } finally {
      if (previous === undefined) delete process.env.NIMBALYST_USER_DATA_DIR;
      else process.env.NIMBALYST_USER_DATA_DIR = previous;
    }
  });
});

describe('E2E launcher agent isolation', () => {
  it('does not inherit live account, routing or permission settings', () => {
    const env = buildTestEnv('http://127.0.0.1:5273', { env: {
      CODEX_HOME: '/working/codex',
      CODEX_APP_TOOLS_PIPE_PATH: 'synthetic-live-pipe',
      CODEX_THREAD_ID: 'working-thread',
      CLAUDE_CONFIG_DIR: '/working/claude',
      OPENAI_API_KEY: 'synthetic-only',
      GH_TOKEN: 'synthetic-only',
      NIMBALYST_ALLOW_CODEX_ACCESS: '1',
      NIMBALYST_ALLOW_OPENAI_API: '1',
    } });
    expect(env.NIMBALYST_ALLOW_CODEX_ACCESS).toBe('0');
    expect(env.NIMBALYST_ALLOW_OPENAI_API).toBe('0');
    expect(env.CODEX_APP_TOOLS_PIPE_PATH).toBeUndefined();
    expect(env.CODEX_THREAD_ID).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.CODEX_HOME).toBe(path.join(env.USERPROFILE, '.codex'));
    expect(env.CLAUDE_CONFIG_DIR).toBe(path.join(env.USERPROFILE, '.claude'));
    expect(env.USERPROFILE.startsWith(env.NIMBALYST_USER_DATA_DIR)).toBe(true);
    expect(env.HOME).toBe(env.USERPROFILE);
  });

  it('keeps agent isolation when session restore disables the Playwright runtime flag', () => {
    const env = buildTestEnv('http://127.0.0.1:5273', { env: { ENABLE_SESSION_RESTORE: '1' } });
    expect(env.PLAYWRIGHT).toBeUndefined();
    expect(env.NIMBALYST_ALLOW_CODEX_ACCESS).toBe('0');
    expect(env.NIMBALYST_ALLOW_OPENAI_API).toBe('0');
    expect(env.CODEX_HOME.startsWith(env.NIMBALYST_USER_DATA_DIR)).toBe(true);
  });
});

describe('built E2E renderer isolation', () => {
  it('never probes a running dev app for an explicit built main or packaged executable', async () => {
    const probe = vi.fn(async () => 'http://127.0.0.1:5273');
    expect(await resolveTestRendererUrl('/synthetic/main.js', undefined, probe)).toBe('');
    expect(await resolveTestRendererUrl(undefined, '/synthetic/Nimbalyst.exe', probe)).toBe('');
    expect(probe).not.toHaveBeenCalled();
    expect(buildTestEnv('').ELECTRON_RENDERER_URL).toBeUndefined();
  });
  it('retains the ordinary dev launcher when no build is selected', async () => {
    const probe = vi.fn(async () => 'http://127.0.0.1:5273');
    expect(await resolveTestRendererUrl(undefined, undefined, probe)).toBe('http://127.0.0.1:5273');
    expect(probe).toHaveBeenCalledOnce();
  });
});
