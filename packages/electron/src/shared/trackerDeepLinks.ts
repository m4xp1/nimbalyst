export type TrackerDeepLinkView = 'document';

export interface TrackerDeepLinkTarget {
  trackerId: string;
  orgId: string;
  scope?: 'files';
  view?: TrackerDeepLinkView;
}

export function isPortableTrackerLinkId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{3,100}$/.test(id);
}

/**
 * Parse and validate a tracker deep link at the main-process routing boundary.
 */
export function parseTrackerDeepLink(rawUrl: string): TrackerDeepLinkTarget {
  const parsed = new URL(rawUrl);
  const isTrackerRoute = parsed.protocol === 'nimbalyst:'
    && (parsed.host === 'tracker' || parsed.pathname.startsWith('/tracker/'));
  if (!isTrackerRoute) {
    throw new Error('URL is not a Nimbalyst tracker deep link');
  }

  const encodedTrackerId = parsed.host === 'tracker'
    ? parsed.pathname.replace(/^\//, '')
    : parsed.pathname.replace('/tracker/', '');

  let trackerId: string;
  try {
    trackerId = decodeURIComponent(encodedTrackerId);
  } catch {
    throw new Error('Tracker deep link has a malformed trackerId');
  }

  const scope = parsed.searchParams.get('scope');
  if (scope !== null && scope !== 'files') throw new Error('Tracker deep link has unsupported scope');
  const fileScope = scope === 'files';
  const orgId = fileScope ? '' : parsed.searchParams.get('orgId');
  if (fileScope && (!isPortableTrackerLinkId(trackerId) || parsed.searchParams.has('orgId'))) {
    throw new Error('File tracker deep link requires a portable card ID without an organization');
  }
  if (!trackerId || !fileScope && !orgId) {
    throw new Error('Tracker deep link requires trackerId and orgId');
  }

  const rawView = parsed.searchParams.get('view');
  if (rawView !== null && rawView !== 'document') {
    throw new Error(`Tracker deep link has unsupported view: ${rawView}`);
  }

  return {
    trackerId,
    orgId: orgId ?? '',
    ...(fileScope ? { scope: 'files' as const } : {}),
    ...(rawView === 'document' ? { view: rawView } : {}),
  };
}
