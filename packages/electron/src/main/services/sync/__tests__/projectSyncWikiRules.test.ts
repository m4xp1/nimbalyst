// @vitest-environment node
/**
 * Project file sync inside a Local wiki folder. File identity on the wire is
 * the path, so a page rename on desktop A reaches desktop B as delete(old) +
 * add(new). Desktops never delete on a remote delete, so before these rules B
 * kept the old file, pushed it back, and the wiki library then saw two files
 * with one id and rewrote one of them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from 'fs/promises';

vi.mock('../../SyncManager', () => ({ getPersonalDocSyncConfig: () => null }));
vi.mock('../../../database/PGLiteDatabaseWorker', () => ({ database: { query: vi.fn(async () => ({ rows: [] })) } }));

import { ProjectFileSyncService } from '../../ProjectFileSyncService';
import { dirtyEditorRegistry } from '../../DirtyEditorRegistry';
import { openWiki } from '@nimbalyst/local-wiki';

const WIKI = 'nimbalyst-local/wiki';
const ID = '01J9Z3K6V4C2W8N5QX7R1T0BHM';
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const syncIdOf = (rel: string) => sha256(rel);
const page = (id: string, body = '# Zebra\n\nNotes.\n') => `---\nid: ${id}\n---\n${body}`;
const ack = async (_p: string, syncId: string) => ({ stored: [syncId], rejected: [], unconfirmed: [] });
const ackBatch = async (_p: string, files: Array<{ syncId: string }>) => ({ stored: files.map((f) => f.syncId), rejected: [], unconfirmed: [] });

describe('project file sync inside a Local wiki', () => {
  let ws: string;
  let wiki: string;
  let service: ProjectFileSyncService;
  let pushFileContent: ReturnType<typeof vi.fn>;
  let pushFileBatch: ReturnType<typeof vi.fn>;
  let deleteFile: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    dirtyEditorRegistry.clear();
    ws = await mkdtemp(path.join(os.tmpdir(), 'pfs-wiki-'));
    wiki = path.join(ws, ...WIKI.split('/'));
    await mkdir(wiki, { recursive: true });
    await writeFile(path.join(wiki, '.nimbalyst-wiki.yaml'), 'formatVersion: 1\n');
    service = new ProjectFileSyncService();
    pushFileContent = vi.fn(ack);
    pushFileBatch = vi.fn(ackBatch);
    deleteFile = vi.fn();
    (service as any).provider = { pushFileContent, pushFileBatch, deleteFile, disconnectAll: vi.fn() };
    (service as any)._fileMapCache = new Map([['proj', { fileMap: new Map(), workspacePath: ws }]]);
    (service as any).projectStates.set('proj', new Map());
  });

  afterEach(async () => {
    service.shutdown();
    await rm(ws, { recursive: true, force: true });
  });

  /** A file this desktop already synced: on disk, with a baseline and a file-map entry. */
  async function seedSynced(rel: string, content: string) {
    const abs = path.join(ws, ...rel.split('/'));
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf-8');
    const syncId = syncIdOf(rel);
    const mtime = Math.floor((await stat(abs)).mtimeMs);
    (service as any).projectStates.get('proj').set(syncId, { syncId, contentHash: sha256(content), lastSyncedMtime: mtime });
    (service as any)._fileMapCache.get('proj').fileMap.set(syncId, abs);
    return { abs, syncId };
  }

  const remoteFile = (rel: string, content: string) => ({
    syncId: syncIdOf(rel), relativePath: rel, title: path.posix.basename(rel, '.md'),
    content, contentHash: sha256(content), lastModifiedAt: Date.now() + 1000, hasYjs: false,
  });

  const trashEntries = async () => {
    try {
      return await readdir(path.join(wiki, '.trash'));
    } catch {
      return [];
    }
  };

  /** B ends with one live page carrying the id, the old copy in trash, and nothing pushed back. */
  async function expectMovedCleanly() {
    expect((await readdir(wiki)).filter((n) => n.endsWith('.md'))).toEqual(['Apple.md']);
    expect(await readFile(path.join(wiki, 'Apple.md'), 'utf-8')).toBe(page(ID));
    const entries = await trashEntries();
    expect(entries).toHaveLength(1);
    const entryDir = path.join(wiki, '.trash', entries[0]);
    expect(await readFile(path.join(entryDir, 'Zebra.md'), 'utf-8')).toBe(page(ID));
    expect(JSON.parse(await readFile(path.join(entryDir, '.trash.json'), 'utf-8'))).toMatchObject({
      formatVersion: 1, kind: 'page', id: ID, originalDir: '', entries: { md: 'Zebra.md' },
    });
    expect(pushFileContent).not.toHaveBeenCalled();
    expect(pushFileBatch).not.toHaveBeenCalled();
    expect((service as any)._fileMapCache.get('proj').fileMap.has(syncIdOf(`${WIKI}/Zebra.md`))).toBe(false);

    const lib = await openWiki(wiki, { repair: false });
    const snapshot = await lib.snapshot();
    expect(snapshot.pages.filter((p) => p.trashedAt === null).map((p) => [p.id, p.path])).toEqual([[ID, 'Apple.md']]);
    expect(snapshot.issues.filter((i) => i.code === 'duplicate-id')).toEqual([]);
  }

  it('applies a rename that arrives as delete then add (realtime) as a move', async () => {
    const old = await seedSynced(`${WIKI}/Zebra.md`, page(ID));

    await (service as any).handleRemoteFileDelete('proj', old.syncId);
    await (service as any).handleRemoteFileUpdate('proj', remoteFile(`${WIKI}/Apple.md`, page(ID)));

    await expectMovedCleanly();
  });

  it('applies a rename that arrives in one sync response, without pushing the old path back', async () => {
    const old = await seedSynced(`${WIKI}/Zebra.md`, page(ID));

    // The server tombstoned the old path, and asks for it because B's manifest still lists it.
    await (service as any).handleSyncResponse('proj', {
      updatedFiles: [], newFiles: [remoteFile(`${WIKI}/Apple.md`, page(ID))],
      deletedSyncIds: [old.syncId], needFromClient: [old.syncId], yjsUpdates: [],
    });

    await expectMovedCleanly();
  });

  it('keeps the file when no other wiki file carries its id, or the check cannot be verified', async () => {
    const other = '01J9Z3K6V4C2W8N5QX7R1T0BHN';
    const lone = await seedSynced(`${WIKI}/Lone.md`, page('01J9Z3K6V4C2W8N5QX7R1T0BHP'));
    // Same id, but the other copy's frontmatter does not parse: not proof of a move.
    const edited = await seedSynced(`${WIKI}/Zebra.md`, page(ID));
    await writeFile(path.join(wiki, 'Apple.md'), `---\nid: ${ID}\ntitle: [unclosed\n---\n`, 'utf-8');
    // Same id at another path, but the old copy has unsynced local edits.
    const diverged = await seedSynced(`${WIKI}/Diverged.md`, page(other, '# old\n'));
    await writeFile(diverged.abs, page(other, '# local edit\n'), 'utf-8');
    await writeFile(path.join(wiki, 'Moved.md'), page(other, '# old\n'), 'utf-8');

    for (const f of [lone, edited, diverged]) await (service as any).handleRemoteFileDelete('proj', f.syncId);

    expect(await readFile(lone.abs, 'utf-8')).toBe(page('01J9Z3K6V4C2W8N5QX7R1T0BHP'));
    expect(await readFile(edited.abs, 'utf-8')).toBe(page(ID));
    expect(await readFile(diverged.abs, 'utf-8')).toBe(page(other, '# local edit\n'));
    expect(await trashEntries()).toEqual([]);
  });

  it('never syncs the wiki trash folder', async () => {
    const { isProjectSyncPath } = await import('../projectSyncWikiRules');
    const trashed = path.join(wiki, '.trash', `1760000000000-${ID}`, 'Zebra.md');
    await mkdir(path.dirname(trashed), { recursive: true });
    await writeFile(trashed, page(ID), 'utf-8');
    await writeFile(path.join(wiki, 'Apple.md'), page(ID), 'utf-8');

    expect(isProjectSyncPath(trashed, ws)).toBe(false);
    expect(isProjectSyncPath(path.join(wiki, 'Apple.md'), ws)).toBe(true);
    expect(isProjectSyncPath(path.join(ws, 'notes', '.trash', 'x.md'), ws)).toBe(true);
    expect(isProjectSyncPath(path.join(wiki, 'Apple.csv'), ws)).toBe(false);

    await service.handleFileSaved(trashed, ws, 'proj');
    expect(pushFileContent).not.toHaveBeenCalled();
    const manifest = await (service as any).buildManifest(ws, 'proj', { seedBaseline: true });
    expect(manifest.map((f: any) => f.syncId)).toEqual([syncIdOf(`${WIKI}/Apple.md`)]);
    // An older client may already have put trash files in the room.
    await (service as any).handleRemoteFileUpdate('proj', remoteFile(`${WIKI}/.trash/1-${ID}/Old.md`, page(ID)));
    expect(await readdir(path.join(wiki, '.trash'))).toEqual([`1760000000000-${ID}`]);
  });

  it('does not bring back a page this desktop moved while sync was not running', async () => {
    // A synced Zebra.md, then `nim` renamed it to Apple.md while the app was closed.
    const old = await seedSynced(`${WIKI}/Zebra.md`, page(ID));
    await rm(old.abs);
    await writeFile(path.join(wiki, 'Apple.md'), page(ID), 'utf-8');

    // The server still has Zebra.md and offers it as new, since absence is not deletion.
    await (service as any).handleSyncResponse('proj', {
      updatedFiles: [], newFiles: [remoteFile(`${WIKI}/Zebra.md`, page(ID))], deletedSyncIds: [], needFromClient: [], yjsUpdates: [],
    });

    expect((await readdir(wiki)).filter((n) => n.endsWith('.md'))).toEqual(['Apple.md']);
    expect(deleteFile).toHaveBeenCalledWith('proj', old.syncId);
  });
});
