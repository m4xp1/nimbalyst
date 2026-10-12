import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { load } from 'js-yaml';
import { EXTENSION_OWNED_KEYS, LEGACY_KEY_TO_TYPE } from '@nimbalyst/runtime/plugins/TrackerPlugin/documentHeader/frontmatterUtils';

export interface FileTrackerIdentity {
  id?: string;
  type?: string;
  source?: string | null;
  workspace?: string;
  sourceRef?: string | null;
  documentPath?: string | null;
  source_ref?: string | null;
  document_path?: string | null;
  data?: unknown;
  customFields?: Record<string, unknown>;
  origin?: { kind?: string };
  body_version?: string | number | null;
  bodyVersion?: number;
}

export function isFileTracker(item: FileTrackerIdentity): boolean {
  let data = item.data ?? item.customFields;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { return false; }
  }
  const meta = data && typeof data === 'object' ? data as Record<string, any> : {};
  if (item.origin?.kind === 'external' || meta.origin?.kind === 'external' || meta.customFields?.origin?.kind === 'external') return false;
  const sharing = meta.share ?? meta.customFields?.share;
  const published = meta.shared === true || meta.customFields?.shared === true || sharing?.body === 'team' || sharing?.status === 'team';
  // Legacy published rows can retain file provenance. Their established room
  // body is not a file projection and must survive local projection cleanup.
  if (published && Number(item.body_version ?? item.bodyVersion ?? 0) > 0) return false;
  return (item.source === 'frontmatter' || item.source === 'import')
    && !!(item.sourceRef || item.source_ref || item.documentPath || item.document_path);
}

export interface FileTrackerBody {
  workspace: string;
  path: string;
  relativePath: string;
  text: string;
  markdown: string;
  frontmatter: Record<string, unknown>;
  version: string;
}

export class FileTrackerConflictError extends Error {
  constructor() {
    super('The tracker file changed while it was being edited. Read it again before retrying.');
    this.name = 'FileTrackerConflictError';
  }
}

export async function resolveFileTrackerPath(workspace: string, item: FileTrackerIdentity): Promise<string> {
  if (item.workspace && path.resolve(item.workspace) !== path.resolve(workspace)) {
    throw new Error('The tracker belongs to a different workspace.');
  }
  const ref = item.sourceRef || item.source_ref || item.documentPath || item.document_path;
  if (!ref || /^[a-z][a-z\d+.-]*:\/\//i.test(ref) || !/\.(md|markdown)$/i.test(ref)) {
    throw new Error('The tracker does not reference a Markdown file.');
  }
  const root = await fs.realpath(workspace);
  const candidate = path.resolve(workspace, ref.replace(/[\\/]/g, path.sep));
  const real = await fs.realpath(candidate);
  const relative = path.relative(root, real);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('The tracker file is outside its workspace.');
  }
  return candidate;
}

/** Preserve whitespace in the body; only the YAML envelope is removed. */
export function splitTrackerMarkdown(text: string): { header: string; markdown: string; frontmatter: Record<string, unknown> } {
  const match = text.match(/^(?:\uFEFF)?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!match) throw new Error('The tracker file has no YAML frontmatter.');
  const parsed = load(match[1]);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid tracker frontmatter.');
  return { header: match[0], markdown: text.slice(match[0].length), frontmatter: parsed as Record<string, unknown> };
}

export function trackerTypeInFrontmatter(frontmatter: Record<string, unknown>): string | null {
  for (const [key, type] of Object.entries(EXTENSION_OWNED_KEYS)) {
    if (frontmatter[key] && typeof frontmatter[key] === 'object') return type;
  }
  const status = frontmatter.trackerStatus as Record<string, unknown> | undefined;
  if (status && typeof status === 'object' && !Array.isArray(status)) {
    return typeof status.type === 'string' && status.type.trim() ? status.type.trim() : 'plan';
  }
  for (const [key, type] of Object.entries(LEGACY_KEY_TO_TYPE)) {
    if (frontmatter[key] && typeof frontmatter[key] === 'object') return type;
  }
  return null;
}

export async function readFileTrackerBody(workspace: string, item: FileTrackerIdentity): Promise<FileTrackerBody> {
  if (!isFileTracker(item)) throw new Error('This tracker has no authoritative file body.');
  const filePath = await resolveFileTrackerPath(workspace, item);
  const text = await fs.readFile(filePath, 'utf8');
  const parsed = splitTrackerMarkdown(text);
  const type = trackerTypeInFrontmatter(parsed.frontmatter);
  if (!type || (item.type && type !== item.type)) throw new Error('The file no longer declares this tracker card.');
  return {
    workspace,
    path: filePath,
    relativePath: path.relative(workspace, filePath).split(path.sep).join('/'),
    text,
    markdown: parsed.markdown,
    frontmatter: parsed.frontmatter,
    version: createHash('sha256').update(text).digest('hex'),
  };
}

// One main-process lane per file, including metadata writes. An external edit is
// also checked by content hash immediately before the write.
const fileWrites = new Map<string, Promise<unknown>>();
export async function withFileTrackerWrite<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const key = process.platform === 'win32' ? path.resolve(filePath).toLowerCase() : path.resolve(filePath);
  const previous = fileWrites.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  fileWrites.set(key, next);
  try { return await next; } finally { if (fileWrites.get(key) === next) fileWrites.delete(key); }
}

export async function writeFileTrackerSnapshot(snapshot: FileTrackerBody, text: string, expectedVersion?: string): Promise<void> {
  await resolveFileTrackerPath(snapshot.workspace, { source_ref: snapshot.relativePath });
  if (expectedVersion && expectedVersion !== snapshot.version) throw new FileTrackerConflictError();
  const current = await fs.readFile(snapshot.path, 'utf8');
  if (createHash('sha256').update(current).digest('hex') !== snapshot.version) throw new FileTrackerConflictError();
  await fs.writeFile(snapshot.path, text, 'utf8');
}
