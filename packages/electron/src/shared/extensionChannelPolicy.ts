/** Fork policy shared by extension discovery and agent workflow discovery. */
export function isExtensionVisibleForChannel(
  manifest: { id?: string; requiredReleaseChannel?: string },
  currentChannel: 'stable' | 'alpha',
): boolean {
  const requiredChannel = manifest.requiredReleaseChannel;
  // Git is available on Stable in this fork, including Marketplace overrides.
  // Enabled state and permissions are checked separately by the existing host.
  if (manifest.id === 'com.nimbalyst.git' && requiredChannel === 'alpha') return true;
  if (!requiredChannel || requiredChannel === 'stable') return true;
  if (requiredChannel === 'alpha') return currentChannel === 'alpha';
  return true;
}
