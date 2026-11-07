import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { dump, JSON_SCHEMA, load } from 'js-yaml';
import { applyFrontmatterOps, type FrontmatterOp } from '@nimbalyst/runtime/plugins/TrackerPlugin/documentHeader/frontmatterSource';
import { withFileTrackerWrite, FileTrackerConflictError } from './fileTrackerBody';
import { FILE_TRACKER_CONFIG_PATH, parseFileTrackerStorageConfig, resolveTrackerDirectory } from './fileTrackerStorageConfig';
import type { FileTrackerStorageConfig } from './fileTrackerStorageConfig';
import { ensureFileTrackerGitVisibility } from './fileTrackerGitVisibility';

export const FILE_TRACKER_HEADER_BYTES = 16 * 1024;
export interface FileTrackerDraft {
  id: string;
  type: string;
  fields: Record<string, unknown>;
  body: string;
}
export interface StoredFileTracker extends FileTrackerDraft {
  relativePath: string;
  version: string;
  text: string;
}
const reserved = new Set(['id', 'trackerFormat', 'trackerStatus', 'creationHash', 'portableId']);
const localOnly = new Set(['linkedSessions', 'agentSessions', 'activity', 'revisions', 'kanbanSortOrder', 'metaAgent']);
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  return value;
}
function validateFields(fields: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(fields)) {
    if (reserved.has(key)) throw new Error(`Tracker identity field '${key}' cannot be edited`);
    if (localOnly.has(key)) throw new Error(`Tracker field '${key}' is local application state`);
    if (value === undefined) throw new Error(`Undefined tracker field '${key}'; use null to clear it`);
  }
  if (typeof fields.description === 'string' && Array.from(fields.description).length > 500) throw new Error('Short description must be at most 500 characters; put the full description in the Markdown body');
}
function header(text: string): { envelope: string; fields: Record<string, unknown>; body: string } {
  const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) throw new Error('Invalid file tracker frontmatter');
  if (Buffer.byteLength(match[0], 'utf8') > FILE_TRACKER_HEADER_BYTES) throw new Error('Tracker frontmatter exceeds 16 KiB');
  // Dates remain strings; reading a card never manufactures a timezone.
  const fields = load(match[1], { schema: JSON_SCHEMA });
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Error('Tracker frontmatter must be a mapping');
  return { envelope: match[0], fields: fields as Record<string, unknown>, body: text.slice(match[0].length) };
}
function checkRelative(relative: string): void {
  if (!relative || /[\\:\u0000-\u001f]/.test(relative) || relative.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('Tracker path must be a portable relative path');
}
function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** File-only persistence. No database or application singleton is needed to restore cards. */
export class FileTrackerStore {
  constructor(private readonly workspace: string, private readonly beforeWrite: (relativePath: string) => void = () => {}) {}

  async config() {
    return (await this.configSnapshot()).config;
  }

  async configSnapshot(): Promise<{ config: FileTrackerStorageConfig; version: string }> {
    // Parse and hash the same bytes; otherwise an external edit between reads
    // could supply old fields with a new version and defeat conflict detection.
    await fs.realpath(this.workspace);
    let text = '';
    let exists = true;
    try { text = await fs.readFile(await this.resolve(FILE_TRACKER_CONFIG_PATH, false), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; exists = false; }
    const parsed = exists ? load(text, { schema: JSON_SCHEMA }) : undefined;
    if (exists && parsed === undefined) throw new Error('Invalid empty tracker storage configuration');
    return { config: parseFileTrackerStorageConfig(parsed), version: digest(text) };
  }

  async saveConfig(value: unknown, expectedVersion: string): Promise<{ config: FileTrackerStorageConfig; version: string }> {
    const config = parseFileTrackerStorageConfig(value);
    const text = dump(config, { lineWidth: -1, noRefs: true });
    if ((await this.configSnapshot()).version !== expectedVersion) throw new FileTrackerConflictError();
    // Verify portability before enabling Files mode. The final auxiliary write
    // checks the same version again after these asynchronous Git operations.
    // Keep the block on Database switches: existing file cards are unchanged.
    if (config.mode === 'files') await ensureFileTrackerGitVisibility(this.workspace);
    await this.writeAuxiliary(FILE_TRACKER_CONFIG_PATH, text, expectedVersion);
    return this.configSnapshot();
  }

  async readComments(card: Pick<StoredFileTracker, 'id'>): Promise<Record<string, unknown>[]> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{3,100}$/.test(card.id)) throw new Error('Invalid tracker ID');
    let text: string;
    try { text = await fs.readFile(await this.resolve(`.nimbalyst/tracker-comments/${card.id}.jsonl`, false), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const comments = text.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
    if (comments.some(comment => !comment || typeof comment !== 'object' || typeof comment.id !== 'string')) throw new Error('Invalid tracker comments file');
    return comments;
  }

  async writeComments(card: Pick<StoredFileTracker, 'id'>, comments: Record<string, unknown>[], expected: Record<string, unknown>[]): Promise<void> {
    const current = await this.readComments(card);
    if (JSON.stringify(current) !== JSON.stringify(expected)) throw new FileTrackerConflictError();
    if (JSON.stringify(current) === JSON.stringify(comments)) return;
    const relative = `.nimbalyst/tracker-comments/${card.id}.jsonl`;
    let old = '';
    try { old = await fs.readFile(await this.resolve(relative, false), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (JSON.stringify(old.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line))) !== JSON.stringify(expected)) throw new FileTrackerConflictError();
    await this.writeAuxiliary(relative, comments.map(comment => JSON.stringify(comment)).join('\n') + (comments.length ? '\n' : ''), digest(old));
  }

  private async writeAuxiliary(relative: string, text: string, expectedVersion: string): Promise<void> {
    const target = await this.resolve(relative, true);
    await withFileTrackerWrite(target, async () => {
      let old = '';
      let exists = true;
      try { old = await fs.readFile(target, 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; exists = false; }
      if (digest(old) !== expectedVersion) throw new FileTrackerConflictError();
      if (old === text) return;
      const temp = `${target}.${randomUUID()}.nimbalyst-tmp`;
      const handle = await fs.open(temp, 'wx');
      try { await handle.writeFile(text, 'utf8'); await handle.sync(); } finally { await handle.close(); }
      try {
        if (exists) {
          if (digest(await fs.readFile(target, 'utf8')) !== expectedVersion) throw new FileTrackerConflictError();
          await fs.rename(temp, target);
        } else await fs.link(temp, target);
      } finally { await fs.unlink(temp).catch(() => {}); }
    });
  }

  private async resolve(relative: string, createParents: boolean): Promise<string> {
    checkRelative(relative);
    const root = await fs.realpath(this.workspace);
    const segments = relative.split('/');
    let cursor = root;
    for (const segment of segments.slice(0, -1)) {
      cursor = path.join(cursor, segment);
      if (createParents) {
        try { await fs.mkdir(cursor); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      }
      if (!within(root, await fs.realpath(cursor))) throw new Error('Tracker path escapes its workspace');
    }
    const target = path.join(cursor, segments.at(-1)!);
    try {
      const stat = await fs.lstat(target);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Tracker destination must be a regular file');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return target;
  }

  async read(relativePath: string): Promise<StoredFileTracker> {
    const text = await fs.readFile(await this.resolve(relativePath, false), 'utf8');
    const { fields, body } = header(text);
    const marker = fields.trackerStatus as { type?: unknown } | undefined;
    if (fields.trackerFormat !== 1 || typeof fields.id !== 'string' || typeof marker?.type !== 'string') throw new Error('Unsupported file tracker identity or format');
    const data = Object.fromEntries(Object.entries(fields).filter(([key]) => !reserved.has(key)));
    return { id: fields.id, type: marker.type, fields: data, body, text, relativePath, version: digest(text) };
  }

  private async findById(id: string, config: FileTrackerStorageConfig): Promise<StoredFileTracker | undefined> {
    const visited = new Set<string>();
    let found: StoredFileTracker | undefined;
    const walk = async (directory: string): Promise<void> => {
      if (visited.has(directory)) return;
      visited.add(directory);
      // resolve a sentinel to validate every directory against workspace boundaries.
      let entries: import('node:fs').Dirent[];
      try { entries = await fs.readdir(path.dirname(await this.resolve(`${directory}/.tracker-scan`, false)), { withFileTypes: true }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      for (const entry of entries) {
        const relative = `${directory}/${entry.name}`;
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) { await walk(relative); continue; }
        if (!entry.isFile() || !/\.md$/i.test(entry.name)) continue;
        const handle = await fs.open(await this.resolve(relative, false), 'r');
        const buffer = Buffer.alloc(FILE_TRACKER_HEADER_BYTES);
        let text: string;
        try { const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0); text = buffer.toString('utf8', 0, bytesRead); }
        finally { await handle.close(); }
        const envelope = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
        if (!envelope) {
          if (/^trackerFormat:/m.test(text)) throw new Error(`Invalid or oversized tracker frontmatter in ${relative}`);
          continue;
        }
        let identity: any;
        try { identity = load(envelope[1], { schema: JSON_SCHEMA }); }
        catch (error) { if (/^trackerFormat:/m.test(text)) throw error; continue; }
        if (!identity?.trackerFormat || identity.id !== id) continue;
        const candidate = await this.read(relative);
        if (found && found.relativePath !== candidate.relativePath) throw new Error(`Duplicate tracker ID ${id} in ${found.relativePath} and ${candidate.relativePath}`);
        found = candidate;
      }
    };
    for (const directory of new Set(Object.values(config.directories))) await walk(directory);
    return found;
  }

  async create(draft: FileTrackerDraft, knownRelativePath?: string): Promise<StoredFileTracker> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{3,100}$/.test(draft.id)) throw new Error('A stable portable tracker ID is required');
    const identityLane = path.join(await fs.realpath(this.workspace), '.nimbalyst', 'tracker-identity', draft.id);
    return withFileTrackerWrite(identityLane, () => this.createNow(draft, knownRelativePath));
  }

  private async createNow(draft: FileTrackerDraft, knownRelativePath?: string): Promise<StoredFileTracker> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{3,100}$/.test(draft.id)) throw new Error('A stable portable tracker ID is required');
    if (!draft.fields.title || typeof draft.fields.title !== 'string') throw new Error('Tracker title is required');
    validateFields(draft.fields);
    const { authorIdentity: _author, created: _created, updated: _updated, ...requestFields } = draft.fields;
    const requestHash = digest(JSON.stringify(canonical({ ...draft, fields: requestFields })));
    if (knownRelativePath) {
      const existing = await this.read(knownRelativePath);
      if (existing.id !== draft.id || header(existing.text).fields.creationHash !== requestHash) throw new Error('This creation ID already saved a different draft');
      return existing;
    }
    const config = await this.config();
    if (config.mode !== 'files') throw new Error('File tracker storage is not enabled');
    const relative = `${resolveTrackerDirectory(config, draft.type)}/${draft.id}.md`;
    const stamp = new Date().toISOString();
    const text = `---\n${dump({ trackerFormat: 1, id: draft.id, trackerStatus: { type: draft.type }, creationHash: requestHash, ...draft.fields, created: stamp, updated: stamp }, { lineWidth: -1, noRefs: true })}---\n${draft.body}`;
    header(text);
    const found = await this.findById(draft.id, config);
    if (found) {
      if (header(found.text).fields.creationHash !== requestHash) throw new Error('This creation ID already saved a different draft');
      return found;
    }
    const target = await this.resolve(relative, true);
    return withFileTrackerWrite(target, async () => {
      try {
        const existing = await this.read(relative);
        if (header(existing.text).fields.creationHash !== requestHash) throw new Error('This creation ID already saved a different draft');
        return existing;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      try {
        await this.publish(target, relative, text);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const winner = await this.read(relative);
        if (header(winner.text).fields.creationHash !== requestHash) throw new Error('This creation ID already saved a different draft');
        return winner;
      }
      return this.read(relative);
    });
  }

  async update(relative: string, updates: Record<string, unknown>, expectedVersion: string, body?: string): Promise<StoredFileTracker> {
    validateFields(updates);
    const target = await this.resolve(relative, false);
    return withFileTrackerWrite(target, async () => {
      const current = await this.read(relative);
      if (current.version !== expectedVersion) throw new FileTrackerConflictError();
      const ops: FrontmatterOp[] = Object.entries(updates).map(([key, value]) => value === null ? { kind: 'delete', key } : { kind: 'set', key, value });
      let next = applyFrontmatterOps(current.text, ops);
      if (body !== undefined) next = header(next).envelope + body;
      if (next === current.text) return current;
      next = applyFrontmatterOps(next, [{ kind: 'set', key: 'updated', value: new Date().toISOString() }]);
      header(next);
      await this.publish(target, relative, next, current);
      return this.read(relative);
    });
  }

  async remove(relative: string, expectedVersion: string): Promise<void> {
    const target = await this.resolve(relative, false);
    await withFileTrackerWrite(target, async () => {
      const card = await this.read(relative);
      if (card.version !== expectedVersion) throw new FileTrackerConflictError();
      const backup = await this.resolve(`nimbalyst-local/tracker-backups/${card.id}/${card.version}.snapshot`, true);
      try { await fs.writeFile(backup, card.text, { flag: 'wx' }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      if ((await this.read(relative)).version !== expectedVersion) throw new FileTrackerConflictError();
      await fs.unlink(target);
    });
  }

  private async publish(target: string, relative: string, text: string, previous?: StoredFileTracker): Promise<void> {
    const temp = `${target}.${randomUUID()}.nimbalyst-tmp`;
    const handle = await fs.open(temp, 'wx');
    try { await handle.writeFile(text, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    try {
      this.beforeWrite(relative);
      if (previous) {
        if ((await this.read(relative)).version !== previous.version) throw new FileTrackerConflictError();
        // Retain the previous version locally before replacing the project file.
        const backup = await this.resolve(`nimbalyst-local/tracker-backups/${previous.id}/${previous.version}.snapshot`, true);
        try { await fs.writeFile(backup, previous.text, { flag: 'wx' }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        if ((await this.read(relative)).version !== previous.version) throw new FileTrackerConflictError();
        await fs.rename(temp, target);
      } else {
        // Exclusive publication: another process can never overwrite this ID.
        await fs.link(temp, target);
      }
    } finally { await fs.unlink(temp).catch(() => {}); }
  }
}
