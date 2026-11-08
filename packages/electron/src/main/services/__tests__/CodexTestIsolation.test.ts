// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { spawn } = vi.hoisted(() => ({
  spawn: vi.fn(() => { throw new Error('A test attempted to spawn real Codex'); }),
}));
vi.mock('node:child_process', () => ({ spawn }));
vi.mock('@nimbalyst/runtime/ai/server/protocols/codexAppServer/codexAppServerBinary', () => ({
  resolveCodexBinaryPath: () => '/synthetic/codex',
  getCodexVendorPathEntries: () => [],
}));
vi.mock('../shellEnvironment', () => ({ getEnhancedPath: () => '' }));
vi.mock('../../utils/logger', () => ({ logger: { main: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } } }));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));

import { codexAuthService } from '../CodexAuthService';
import { codexUsageService } from '../CodexUsageService';
import { OpenAICodexProvider } from '@nimbalyst/runtime/ai/server/providers/OpenAICodexProvider';
import { CodexAppServerProtocol } from '@nimbalyst/runtime/ai/server/protocols/CodexAppServerProtocol';
import { CodexSDKProtocol } from '@nimbalyst/runtime/ai/server/protocols/CodexSDKProtocol';

beforeEach(() => {
  vi.stubEnv('PLAYWRIGHT', '1');
  vi.stubEnv('NIMBALYST_ALLOW_CODEX_ACCESS', '0');
  spawn.mockClear();
});
afterEach(() => {
  codexAuthService.shutdown();
  codexUsageService.stop();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('automated app launches do not use the working Codex account', () => {
  it('reports an unsigned-in account without starting an auth process', async () => {
    await expect(codexAuthService.getStatus(true)).resolves.toMatchObject({
      account: null, requiresOpenaiAuth: true, authMode: null,
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('blocks login, logout and quota RPCs before any shared auth process starts', async () => {
    for (const action of [
      () => codexAuthService.startChatGptLogin(),
      () => codexAuthService.loginWithApiKey('synthetic-only'),
      () => codexAuthService.logout(),
      () => codexAuthService.getRateLimits(),
    ]) await expect(action()).rejects.toMatchObject({ code: 'CODEX_ACCESS_DISABLED' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('does not fall back from disabled quota RPCs to personal session logs', async () => {
    const account = vi.spyOn(codexAuthService, 'getRateLimits').mockRejectedValue(new Error('disabled'));
    await expect(codexUsageService.refresh()).resolves.toMatchObject({ limits: [], limitsAvailable: false });
    expect(account).not.toHaveBeenCalled();
  });

  it('keeps an offline model catalog and skips live model and skill discovery', async () => {
    const loadAppServerModels = vi.fn(async () => []);
    expect((await OpenAICodexProvider.getModels(undefined, { loadAppServerModels })).length).toBeGreaterThan(0);
    expect(loadAppServerModels).not.toHaveBeenCalled();
    await expect(OpenAICodexProvider.discoverSkills('/synthetic/workspace')).resolves.toEqual([]);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('blocks direct app-server metadata and session entry points', async () => {
    const protocol = new CodexAppServerProtocol({ resolveCodexPathOverride: () => '/synthetic/codex' });
    for (const action of [
      () => protocol.discoverModels({ workspacePath: '/synthetic/workspace' }),
      () => protocol.discoverSkills({ workspacePath: '/synthetic/workspace' }),
      () => protocol.createSession({ workspacePath: '/synthetic/workspace' }),
    ]) await expect(action()).rejects.toMatchObject({ code: 'CODEX_ACCESS_DISABLED' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('blocks the legacy SDK before it can load credentials or launch a process', async () => {
    const loadSdk = vi.fn(async (): Promise<any> => { throw new Error('SDK must not load'); });
    const protocol = new CodexSDKProtocol('', loadSdk);
    await expect(protocol.createSession({ workspacePath: '/synthetic/workspace' }))
      .rejects.toMatchObject({ code: 'CODEX_ACCESS_DISABLED' });
    expect(loadSdk).not.toHaveBeenCalled();
  });
});
