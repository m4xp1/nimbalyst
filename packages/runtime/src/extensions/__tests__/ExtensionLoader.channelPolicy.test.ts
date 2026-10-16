// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { ExtensionLoader } from '../ExtensionLoader';
import { setExtensionPlatformService, type ExtensionPlatformService } from '../ExtensionPlatformService';

describe('Stable Git extension discovery', () => {
  it('passes identity to the host gate and keeps the Marketplace copy ahead of builtin', async () => {
    const manifest = (id: string, version: string) => ({ id, name: id, version, main: 'dist/index.js', requiredReleaseChannel: 'alpha' });
    const files: Record<string, unknown> = {
      '/user/git/manifest.json': manifest('com.nimbalyst.git', '1.0.3'),
      '/builtin/git/manifest.json': manifest('com.nimbalyst.git', '1.0.2'),
      '/builtin/other/manifest.json': manifest('com.example.alpha', '1.0.0'),
    };
    const gate = vi.fn(async (required: string | undefined, extensionId?: string) => required !== 'alpha' || extensionId === 'com.nimbalyst.git');
    setExtensionPlatformService({
      getAllExtensionsDirectories: async () => ['/user', '/builtin'],
      listDirectories: async (root: string) => root === '/user' ? ['git'] : ['git', 'other'],
      resolvePath: (root: string, name: string) => root + '/' + name,
      fileExists: async (file: string) => file in files,
      readFile: async (file: string) => JSON.stringify(files[file]),
      isExtensionVisibleForChannel: gate,
    } as unknown as ExtensionPlatformService);
    const found = await new ExtensionLoader().discoverExtensions();
    expect(found.map(entry => [entry.path, entry.manifest.version])).toEqual([['/user/git', '1.0.3']]);
    expect(gate).toHaveBeenCalledWith('alpha', 'com.nimbalyst.git');
    expect(gate).toHaveBeenCalledWith('alpha', 'com.example.alpha');
  });
});
