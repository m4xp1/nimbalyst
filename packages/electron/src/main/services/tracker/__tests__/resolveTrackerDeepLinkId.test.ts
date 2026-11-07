// @vitest-environment node
/**
 * Deep-link back-compat after a file-backed plan is promoted to a stable id.
 *
 * Links minted before the promotion (`nimbalyst://tracker/fm%3Aplan%3A…`) and
 * `tracker://fm:…` references already embedded in documents must keep opening
 * the item. So must an issue key, which is what a human actually quotes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { resolveTrackerDeepLinkId, resolvePortableTrackerDeepLinkId } from '../resolveTrackerDeepLinkId';
import { encodeWorkspaceLocalId } from '../portableTrackerIdentity';

const WORKSPACE = '/tmp/workspace';
const REL = 'nimbalyst-local/plans/attachment-staging-location.md';
const PROMOTED_ID = 'plan_1753900000000_a1b2c3';

let db: PGlite;

beforeEach(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE tracker_items (
      id TEXT PRIMARY KEY,
      issue_key TEXT,
      type TEXT NOT NULL,
      workspace TEXT NOT NULL,
      source TEXT,
      source_ref TEXT,
      data JSONB,
      updated TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await db.query(
    `INSERT INTO tracker_items (id, issue_key, type, workspace, source, source_ref)
     VALUES ($1, 'NIM-2324', 'plan', $2, 'native', $3)`,
    [PROMOTED_ID, WORKSPACE, REL],
  );
});

afterEach(async () => {
  await db.close();
});

describe('resolveTrackerDeepLinkId', () => {
  it('resolves a legacy fm: link to the promoted row', async () => {
    const resolved = await resolveTrackerDeepLinkId(db as any, WORKSPACE, `fm:plan:${REL}`);
    expect(resolved).toBe(PROMOTED_ID);
  });

  it('resolves an issue key to the current row id', async () => {
    expect(await resolveTrackerDeepLinkId(db as any, WORKSPACE, 'NIM-2324')).toBe(PROMOTED_ID);
    expect(await resolveTrackerDeepLinkId(db as any, WORKSPACE, 'nim-2324')).toBe(PROMOTED_ID);
  });

  it('passes a live id through untouched', async () => {
    expect(await resolveTrackerDeepLinkId(db as any, WORKSPACE, PROMOTED_ID)).toBe(PROMOTED_ID);
  });

  it('returns an unknown id unchanged so the renderer still gets its shot', async () => {
    expect(await resolveTrackerDeepLinkId(db as any, WORKSPACE, 'plan_missing')).toBe('plan_missing');
    expect(await resolveTrackerDeepLinkId(db as any, WORKSPACE, 'NIM-9999')).toBe('NIM-9999');
  });

  it('does not cross workspaces', async () => {
    expect(await resolveTrackerDeepLinkId(db as any, '/tmp/other', `fm:plan:${REL}`)).toBe(`fm:plan:${REL}`);
  });
  it('resolves portable file IDs and keys inside the active worktree', async () => {
    const stable = 'task-portable-id';
    for (const workspace of [WORKSPACE, `${WORKSPACE}-other`]) {
      await db.query('INSERT INTO tracker_items (id, issue_key, type, workspace, source, source_ref) VALUES ($1, $2, $3, $4, $5, $6)',
        [encodeWorkspaceLocalId(workspace, stable), 'TASK-PORTABLE-ID', 'task', workspace, 'frontmatter', 'cards/task.md']);
      expect(await resolveTrackerDeepLinkId(db as any, workspace, stable)).toBe(encodeWorkspaceLocalId(workspace, stable));
      expect(await resolveTrackerDeepLinkId(db as any, workspace, 'task-portable-id')).toBe(encodeWorkspaceLocalId(workspace, stable));
      expect(await resolveTrackerDeepLinkId(db as any, workspace, 'TASK-PORTABLE-ID')).toBe(encodeWorkspaceLocalId(workspace, stable));
    }
  });
});


describe('resolvePortableTrackerDeepLinkId', () => {
  const portableId = 'task-portable-001';
  it('never resolves a native card UUID or issue key through file scope', async () => {
    expect(await resolvePortableTrackerDeepLinkId(db as any, WORKSPACE, PROMOTED_ID)).toBeNull();
    expect(await resolvePortableTrackerDeepLinkId(db as any, WORKSPACE, 'NIM-2324')).toBeNull();
  });
  it('resolves only the matching projection of the same raw ID in two workspaces', async () => {
    for (const workspace of [WORKSPACE, WORKSPACE + '-worktree']) {
      await db.query('INSERT INTO tracker_items (id, type, workspace, source, data) VALUES ($1, $2, $3, $4, $5)',
        [encodeWorkspaceLocalId(workspace, portableId), 'task', workspace, 'frontmatter', JSON.stringify({ trackerFormat: 1, portableId })]);
    }
    for (const workspace of [WORKSPACE, WORKSPACE + '-worktree']) {
      expect(await resolvePortableTrackerDeepLinkId(db as any, workspace, portableId)).toBe(encodeWorkspaceLocalId(workspace, portableId));
    }
    expect(await resolvePortableTrackerDeepLinkId(db as any, WORKSPACE + '-unknown', portableId)).toBeNull();
  });
  it('fails closed for absent, wrong-marker, and mismatched portable IDs', async () => {
    expect(await resolvePortableTrackerDeepLinkId(db as any, WORKSPACE, portableId)).toBeNull();
    await db.query('INSERT INTO tracker_items (id, type, workspace, source, data) VALUES ($1, $2, $3, $4, $5)',
      [encodeWorkspaceLocalId(WORKSPACE, portableId), 'task', WORKSPACE, 'frontmatter', '{}']);
    expect(await resolvePortableTrackerDeepLinkId(db as any, WORKSPACE, portableId)).toBeNull();
    await db.query('UPDATE tracker_items SET data = $1 WHERE id = $2', [JSON.stringify({ trackerFormat: 1, portableId: 'another-card' }), encodeWorkspaceLocalId(WORKSPACE, portableId)]);
    expect(await resolvePortableTrackerDeepLinkId(db as any, WORKSPACE, portableId)).toBeNull();
  });
  it('does not accept a machine-local ID, legacy path, or malformed raw ID', async () => {
    for (const id of [encodeWorkspaceLocalId(WORKSPACE, portableId), 'fm:plan:docs/x.md', '../secret', '', ' ' + portableId]) {
      expect(await resolvePortableTrackerDeepLinkId(db as any, WORKSPACE, id)).toBeNull();
    }
  });
  it('denies unexpected storage failures and malformed SQLite JSON without legacy fallback', async () => {
    const broken = { query: async () => { throw new Error('Unavailable DB'); } };
    expect(await resolvePortableTrackerDeepLinkId(broken, WORKSPACE, portableId)).toBeNull();
    const malformed = { query: async () => ({ rows: [{ id: encodeWorkspaceLocalId(WORKSPACE, portableId), source: 'frontmatter', data: '{' }] }) };
    expect(await resolvePortableTrackerDeepLinkId(malformed as any, WORKSPACE, portableId)).toBeNull();
  });
});
