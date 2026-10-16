// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const extensionSettings: Record<string, { enabled?: boolean }> = {};
const pluginEnabled: Record<string, boolean | undefined> = {};

vi.mock('../../../utils/store', () => ({
  getExtensionEnabled: (id: string, defaultEnabled?: boolean) =>
    extensionSettings[id]?.enabled ?? defaultEnabled !== false,
  getClaudePluginEnabled: (id: string) => pluginEnabled[id],
}));

import { isWikiSkillAvailable } from '../wikiSkillAvailability';

describe('isWikiSkillAvailable', () => {
  beforeEach(() => {
    for (const key of Object.keys(extensionSettings)) delete extensionSettings[key];
    for (const key of Object.keys(pluginEnabled)) delete pluginEnabled[key];
  });

  it('is opt-in in the fork and respects explicit enablement and disablement', () => {
    expect(isWikiSkillAvailable()).toBe(false);

    extensionSettings['com.nimbalyst.knowledge'] = { enabled: false };
    expect(isWikiSkillAvailable()).toBe(false);

    extensionSettings['com.nimbalyst.knowledge'] = { enabled: true };
    expect(isWikiSkillAvailable()).toBe(true);
    pluginEnabled['com.nimbalyst.knowledge'] = false;
    expect(isWikiSkillAvailable()).toBe(false);
  });
});
