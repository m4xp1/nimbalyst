import { app } from 'electron';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { isFileTracker, type FileTrackerBody } from './fileTrackerBody';

interface ProjectionDb {
  query(sql: string, params: unknown[]): Promise<{ rows: any[] }>;
}

/** Called only AFTER the actual file and card marker have been verified. */
export async function clearLegacyFileTrackerBody(db: ProjectionDb, row: any, file: FileTrackerBody): Promise<void> {
  if (!isFileTracker(row)) return;
  const cache = await db.query('SELECT body_version, content FROM tracker_body_cache WHERE item_id = $1', [row.id]);
  if (row.content == null && cache.rows.length === 0) return;
  const decode = (value: unknown): unknown => {
    if (typeof value !== 'string') return value;
    try { return JSON.parse(value); } catch { return value; }
  };
  const bodies = [row.content, ...cache.rows.map(entry => entry.content)].filter(value => value != null);
  if (bodies.some(value => decode(value) !== file.markdown && String(decode(value)).trim() !== file.markdown.trim())) {
    const payload = JSON.stringify({ workspace: row.workspace, itemId: row.id, sourcePath: file.relativePath, fileVersion: file.version, legacyContent: row.content, cache: cache.rows }, null, 2);
    const name = createHash('sha256').update(`${row.workspace}\0${row.id}\0${JSON.stringify(bodies)}`).digest('hex');
    const directory = path.join(app.getPath('userData'), 'file-tracker-recovery');
    await fs.mkdir(directory, { recursive: true });
    const recoveryPath = path.join(directory, `${name}.json`);
    try { await fs.writeFile(recoveryPath, payload, { encoding: 'utf8', flag: 'wx' }); }
    catch (error: any) {
      if (error.code !== 'EEXIST') throw error;
      // A previous interrupted write must not authorize deleting the only copy.
      const existing = JSON.parse(await fs.readFile(recoveryPath, 'utf8'));
      if (existing.itemId !== row.id || existing.workspace !== row.workspace
        || JSON.stringify(existing.legacyContent) !== JSON.stringify(row.content)
        || JSON.stringify(existing.cache) !== JSON.stringify(cache.rows)) {
        throw new Error('The file tracker recovery copy could not be verified.');
      }
    }
  }
  // Preserve row identity, metadata and links. These statements are repeatable
  // on both stores; if interrupted, the next verified read completes cleanup.
  await db.query("UPDATE tracker_items SET content = NULL WHERE id = $1 AND source IN ('frontmatter', 'import') AND COALESCE(body_version, 0) = $2", [row.id, Number(row.body_version ?? 0)]);
  await db.query("DELETE FROM tracker_body_cache WHERE item_id = $1 AND EXISTS (SELECT 1 FROM tracker_items WHERE id = $1 AND source IN ('frontmatter', 'import') AND content IS NULL AND COALESCE(body_version, 0) = $2)", [row.id, Number(row.body_version ?? 0)]);
  row.content = null;
}
