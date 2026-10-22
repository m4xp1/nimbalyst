/** Optional details preserve the legacy status IPC contract. Counts describe local refs. */
export interface GitSyncTarget {
  remote?: string;
  branch?: string;
  trackingRef?: string;
  remoteRef?: string;
  available: boolean;
  reason?: string;
}
export interface GitSyncStatus {
  push: GitSyncTarget;
  pull: GitSyncTarget;
  freshness: 'local' | 'checking' | 'fresh' | 'error';
  checkedAt?: number;
  error?: string;
}
export function describeGitSync(sync?: GitSyncStatus): string {
  if (!sync) return '';
  const target = (name: string, value: GitSyncTarget) =>
    name + ': ' + (value.remote && value.branch ? value.remote + '/' + value.branch : 'unavailable')
      + (!value.available && value.reason ? ' (' + value.reason + ')' : '');
  return [target('Push', sync.push), target('Pull', sync.pull),
    sync.freshness === 'checking' ? 'Checking remote refs…'
      : sync.freshness === 'error' ? 'Remote check failed; showing local refs'
      : sync.checkedAt ? 'Remote refs checked ' + new Date(sync.checkedAt).toLocaleString()
      : 'Local refs; remote not checked', sync.error].filter(Boolean).join(' · ');
}
