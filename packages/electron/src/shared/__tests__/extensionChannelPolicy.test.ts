// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { isExtensionVisibleForChannel } from '../extensionChannelPolicy';

describe('fork extension channel policy', () => {
  it('permits the Git Marketplace manifest on Stable without opening other alpha extensions', () => {
    expect(isExtensionVisibleForChannel({ id: 'com.nimbalyst.git', requiredReleaseChannel: 'alpha' }, 'stable')).toBe(true);
    for (const id of [undefined, 'com.nimbalyst.git-extra', 'com.example.alpha']) {
      expect(isExtensionVisibleForChannel({ id, requiredReleaseChannel: 'alpha' }, 'stable')).toBe(false);
      expect(isExtensionVisibleForChannel({ id, requiredReleaseChannel: 'alpha' }, 'alpha')).toBe(true);
    }
  });
  it('preserves calls without identity and existing stable and unknown-channel semantics', () => {
    expect(isExtensionVisibleForChannel({ requiredReleaseChannel: 'alpha' }, 'stable')).toBe(false);
    for (const requiredReleaseChannel of [undefined, 'stable', 'future']) {
      expect(isExtensionVisibleForChannel({ requiredReleaseChannel }, 'stable')).toBe(true);
    }
  });
});
