/**
 * Project file sync rules for the project's Local wiki folder (see
 * `packages/local-wiki/FORMAT.md`).
 *
 * File identity on the wire is the path, so a page rename or move on one
 * desktop reaches the others as delete(old) + add(new). Desktops never remove a
 * local file on a remote delete (`ProjectFileSyncService.applyRemoteDelete`), so
 * the old copy stayed, was offered back to the server, and the wiki library
 * then found two files with one `id` and rewrote one of them. Inside the wiki a
 * page carries its own identity in frontmatter, which lets a desktop tell a
 * move from a delete: when the `id` of the file a remote delete names now lives
 * at another path in the wiki, the delete was a move. The stale copy then goes
 * to the wiki's `.trash/` in the library's trash format, never to `unlink`.
 *
 * The wiki's `.trash/` itself is never synced.
 */
import { EventEmitter } from 'events';
import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash, randomBytes } from 'crypto';
import yaml from 'js-yaml';
import { TRASH_DIR, acquireWriteLock } from '@nimbalyst/local-wiki';
import { logger } from '../../utils/logger';
import { dirtyEditorRegistry } from '../DirtyEditorRegistry';
import { localWikiFolderWithin } from '../localWiki/localWikiLocation';

/** FORMAT.md "Trash": written into each entry before anything moves. */
const TRASH_MANIFEST = '.trash.json';
const WIKI_FOLDER_TTL_MS = 5_000;
const MAX_PENDING_DELETES = 500;

const wikiFolderCache = new Map<string, { folder: string | null; at: number }>();

/** The wiki folder relative to the workspace (`/` separators), or null. Cached briefly: the watcher asks per event. */
function wikiFolder(workspacePath: string): string | null {
  const hit = wikiFolderCache.get(workspacePath);
  if (hit && Date.now() - hit.at < WIKI_FOLDER_TTL_MS) return hit.folder;
  const folder = localWikiFolderWithin(workspacePath);
  wikiFolderCache.set(workspacePath, { folder, at: Date.now() });
  return folder;
}

function wikiRootWithin(workspacePath: string): string | null {
  const folder = wikiFolder(workspacePath);
  return folder ? path.join(workspacePath, ...folder.split('/')) : null;
}

function relPosix(from: string, to: string): string {
  return path.relative(from, to).split(path.sep).join('/');
}

function isInside(root: string, filePath: string): boolean {
  const rel = relPosix(root, filePath);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** True for the wiki's `.trash/` folder and anything under it. */
export function isInWikiTrash(filePath: string, workspacePath: string): boolean {
  const root = wikiRootWithin(workspacePath);
  if (!root) return false;
  const rel = relPosix(root, filePath);
  return rel === TRASH_DIR || rel.startsWith(`${TRASH_DIR}/`);
}

/** The one filter for the paths project file sync carries: markdown, outside the wiki's trash. */
export function isProjectSyncPath(filePath: string, workspacePath: string): boolean {
  return filePath.endsWith('.md') && !isInWikiTrash(filePath, workspacePath);
}

const FRONTMATTER_OPEN = /^﻿?---[ \t]*\r?\n/;
const FRONTMATTER_CLOSE = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m;

/** Frontmatter as the library reads it (YAML core schema), or null when absent or unparseable. */
function readFrontmatter(text: string): Record<string, unknown> | null {
  const open = FRONTMATTER_OPEN.exec(text);
  if (!open) return null;
  const rest = text.slice(open[0].length);
  const close = FRONTMATTER_CLOSE.exec(rest);
  if (!close) return null;
  try {
    const data = yaml.load(rest.slice(0, close.index), { schema: yaml.CORE_SCHEMA });
    return data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function pageId(text: string): string | null {
  const id = readFrontmatter(text)?.id;
  return typeof id === 'string' && id.trim() !== '' ? id.trim() : null;
}

const idCache = new Map<string, { mtimeMs: number; size: number; id: string | null }>();

/** Live wiki pages (dot-names and trash skipped, as the library does) whose frontmatter `id` is `id`. */
async function livePagesWithId(root: string, id: string, exclude: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string) => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(abs);
      else if (entry.isFile() && entry.name.endsWith('.md') && abs !== exclude) {
        try {
          const st = await fs.stat(abs);
          let hit = idCache.get(abs);
          if (!hit || hit.mtimeMs !== st.mtimeMs || hit.size !== st.size) {
            hit = { mtimeMs: st.mtimeMs, size: st.size, id: pageId(await fs.readFile(abs, 'utf-8')) };
            idCache.set(abs, hit);
          }
          if (hit.id === id) found.push(abs);
        } catch {
          // vanished or unreadable: not a match
        }
      }
    }
  };
  await walk(root);
  return found;
}

/** Re-read from disk, uncached: the other copy must really carry the id and parse. */
async function firstVerified(paths: string[], id: string): Promise<string | null> {
  for (const candidate of paths) {
    try {
      if (pageId(await fs.readFile(candidate, 'utf-8')) === id) return candidate;
    } catch {
      // gone since the walk
    }
  }
  return null;
}

export interface StaleWikiCopyEvent {
  workspacePath: string;
  id: string;
  /** The copy a remote delete named, about to move into trash. */
  stalePath: string;
  /** The verified live page carrying the same id. */
  livePath: string;
}

/** Emits `stale-copy` before a stale copy moves into the wiki trash, so an interrupted move is still on record. */
export const projectSyncWikiEvents = new EventEmitter();

export interface WikiRulesHost {
  /** Content hash both sides last agreed on for a synced file. */
  baselineHash(projectId: string, syncId: string): string | undefined;
  /** Drop sync state for a path that moved into the wiki trash (no longer synced). */
  forget(projectId: string, syncId: string, filePath: string): Promise<void>;
}

interface PendingDelete {
  projectId: string;
  workspacePath: string;
  syncId: string;
  filePath: string;
  /** The page id the kept file carried when its delete arrived. */
  id: string;
}

export class ProjectSyncWikiRules {
  // Remote deletes inside the wiki that were kept because the page's new path
  // had not arrived yet. A rename sends its delete before its add, so the add
  // settles them. Keyed by absolute path.
  private pendingDeletes = new Map<string, PendingDelete>();

  constructor(private readonly host: WikiRulesHost) {}

  /**
   * A remote delete for `filePath`. Returns true when it was a move and the
   * stale copy is now in the wiki trash; false leaves today's behavior (keep).
   */
  async applyRemoteDelete(projectId: string, workspacePath: string, syncId: string, filePath: string): Promise<boolean> {
    const root = wikiRootWithin(workspacePath);
    if (!root || !isInside(root, filePath) || isInWikiTrash(filePath, workspacePath)) return false;
    let id: string | null = null;
    try {
      id = pageId(await fs.readFile(filePath, 'utf-8'));
    } catch {
      // gone already
    }
    if (!id) return false;
    const pending = { projectId, workspacePath, syncId, filePath, id };
    if (await this.trashIfMoved(root, pending)) return true;
    this.pendingDeletes.delete(filePath);
    this.pendingDeletes.set(filePath, pending);
    if (this.pendingDeletes.size > MAX_PENDING_DELETES) this.pendingDeletes.delete(this.pendingDeletes.keys().next().value!);
    return false;
  }

  /** A remote write landed at `filePath`; a kept delete whose page it carries was a move. */
  async afterRemoteWrite(projectId: string, workspacePath: string, filePath: string, content: string): Promise<void> {
    const id = this.pendingDeletes.size > 0 ? pageId(content) : null;
    if (!id) return;
    const root = wikiRootWithin(workspacePath);
    // Dot-names are not pages to the library, so they cannot be where a page moved.
    if (!root || !isInside(root, filePath) || relPosix(root, filePath).split('/').some((s) => s.startsWith('.'))) return;
    for (const pending of [...this.pendingDeletes.values()]) {
      if (pending.projectId !== projectId || pending.id !== id || pending.filePath === filePath) continue;
      if (await this.trashIfMoved(root, pending, [filePath])) this.pendingDeletes.delete(pending.filePath);
    }
  }

  /**
   * True when the server offers back a wiki page this desktop moved away while
   * sync was not running: the path is gone locally, the server holds exactly
   * the content this desktop last agreed on, and that page's id now lives at
   * another path here. The caller propagates the local delete instead of
   * writing the old path back.
   */
  async isMovedAwayLocally(
    projectId: string,
    workspacePath: string,
    file: { syncId: string; relativePath: string; content: string; contentHash: string },
  ): Promise<boolean> {
    const filePath = path.join(workspacePath, file.relativePath);
    const root = wikiRootWithin(workspacePath);
    if (!root || !isInside(root, filePath)) return false;
    if (this.host.baselineHash(projectId, file.syncId) !== file.contentHash) return false;
    const id = pageId(file.content);
    if (!id) return false;
    const live = await firstVerified(await livePagesWithId(root, id, filePath), id);
    if (!live) return false;
    logger.main.warn(`[ProjectFileSync] ${relPosix(workspacePath, filePath)} moved to ${relPosix(workspacePath, live)} on this desktop; sending the delete instead of restoring the old path`);
    return true;
  }

  /** `candidates`: where the live page is expected; the whole wiki is searched when omitted. */
  private async trashIfMoved(root: string, pending: PendingDelete, candidates?: string[]): Promise<boolean> {
    const { projectId, workspacePath, syncId, filePath } = pending;
    if (dirtyEditorRegistry.isDirty(filePath)) return false;
    let text: string;
    try {
      text = await fs.readFile(filePath, 'utf-8');
    } catch {
      return false;
    }
    const id = pageId(text);
    if (!id || id !== pending.id) return false;
    // Unsynced local edits at the old path: keep it where it is.
    const baseline = this.host.baselineHash(projectId, syncId);
    if (!baseline || createHash('sha256').update(text).digest('hex') !== baseline) return false;
    const livePath = await firstVerified(candidates ?? await livePagesWithId(root, id, filePath), id);
    if (!livePath) return false;

    const event: StaleWikiCopyEvent = { workspacePath, id, stalePath: filePath, livePath };
    logger.main.warn(`[ProjectFileSync] Remote delete of ${relPosix(workspacePath, filePath)} was a move to ${relPosix(workspacePath, livePath)} (id ${id}); moving the stale copy to the wiki trash`);
    projectSyncWikiEvents.emit('stale-copy', event);

    const entryDir = await moveToTrash(root, filePath, id, text);
    if (!entryDir) return false;
    await this.host.forget(projectId, syncId, filePath);
    await removeEmptyFolders(root, filePath);
    logger.main.info(`[ProjectFileSync] Stale copy kept in ${relPosix(workspacePath, entryDir)}`);
    return true;
  }
}

/**
 * Moves the stale copy under the wiki's write lock, so it cannot interleave
 * with a library write from this app or `nim`. Re-reads the file under the
 * lock and leaves it in place if it changed since it was checked.
 */
async function moveToTrash(root: string, filePath: string, id: string, text: string): Promise<string | null> {
  const release = await acquireWriteLock(root, { timeoutMs: 10_000, staleMs: 30_000 });
  if (!release) {
    logger.main.warn(`[ProjectFileSync] Wiki write lock busy; stale copy ${filePath} left in place for now`);
    return null;
  }
  try {
    const current = await fs.readFile(filePath, 'utf-8').catch(() => null);
    if (current !== text) {
      logger.main.info(`[ProjectFileSync] ${filePath} changed before it could be trashed; left in place`);
      return null;
    }
    return await moveToTrashLocked(root, filePath, id, text);
  } finally {
    await release();
  }
}

/** A page entry in the library's trash format: the manifest first, then the file. Returns the entry folder, or null. */
async function moveToTrashLocked(root: string, filePath: string, id: string, text: string): Promise<string | null> {
  const meta = readFrontmatter(text) ?? {};
  let trashedAt = Date.now();
  let entryDir = path.join(root, TRASH_DIR, `${trashedAt}-${id}`);
  for (;;) {
    try {
      await fs.mkdir(path.join(root, TRASH_DIR), { recursive: true });
      await fs.mkdir(entryDir);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        logger.main.error(`[ProjectFileSync] Could not create a wiki trash entry for ${filePath}; left in place:`, err);
        return null;
      }
      trashedAt += 1;
      entryDir = path.join(root, TRASH_DIR, `${trashedAt}-${id}`);
    }
  }
  const name = path.basename(filePath);
  const manifest = {
    formatVersion: 1,
    kind: 'page',
    id,
    title: typeof meta.title === 'string' ? meta.title : path.basename(filePath, '.md'),
    trashedAt,
    originalParentId: null,
    originalDir: relPosix(root, path.dirname(filePath)),
    entries: { md: name },
    pageType: typeof meta.type === 'string' ? meta.type : null,
  };
  try {
    const tmp = path.join(entryDir, `${TRASH_MANIFEST}.${randomBytes(4).toString('hex')}.tmp`);
    await fs.writeFile(tmp, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
    await fs.rename(tmp, path.join(entryDir, TRASH_MANIFEST));
    await fs.rename(filePath, path.join(entryDir, name));
    return entryDir;
  } catch (err) {
    logger.main.error(`[ProjectFileSync] Could not move ${filePath} into the wiki trash; left in place:`, err);
    // Only our manifest is in the entry; the page never left its path.
    await fs.rm(entryDir, { recursive: true, force: true }).catch(() => undefined);
    return null;
  }
}

/**
 * A moved page's children arrive as their own delete+add pairs, so the old
 * child folder empties out one file at a time. An empty folder left behind
 * would read as a bare folder page, so remove it. `rmdir` only succeeds on an
 * empty folder.
 */
async function removeEmptyFolders(root: string, filePath: string): Promise<void> {
  const candidates = [filePath.slice(0, -'.md'.length), path.dirname(filePath)];
  for (const dir of candidates) {
    if (!isInside(root, dir)) continue;
    await fs.rmdir(dir).catch(() => undefined);
  }
}
