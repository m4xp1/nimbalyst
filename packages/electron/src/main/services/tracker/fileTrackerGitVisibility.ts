import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { withFileTrackerWrite } from './fileTrackerBody';

const exec = promisify(execFile);
const begin = '# BEGIN Nimbalyst file tracker';
const end = '# END Nimbalyst file tracker';
const block = [begin,
  '!/.nimbalyst/',
  '/.nimbalyst/*',
  '!/.nimbalyst/tracker-storage.yaml',
  '!/.nimbalyst/trackers/',
  '/.nimbalyst/trackers/*',
  '!/.nimbalyst/trackers/*.yaml',
  '!/.nimbalyst/trackers/*.yml',
  '!/.nimbalyst/tracker-comments/',
  '/.nimbalyst/tracker-comments/*',
  '!/.nimbalyst/tracker-comments/*.jsonl',
  end,
];
const probes = [
  '.nimbalyst/tracker-storage.yaml',
  '.nimbalyst/trackers/nimbalyst-visibility-probe.patch.yaml',
  '.nimbalyst/trackers/nimbalyst-visibility-probe.yml',
  '.nimbalyst/tracker-comments/nimbalyst-visibility-probe.jsonl',
];

export interface TrackerGitignoreSnapshot { file: string; text: string; exists: boolean }

function conflict(): Error {
  return new Error('.gitignore changed while enabling file trackers. Review the Git rules and save the settings again.');
}

/** Read the actual workspace file, refusing symlinks and other special files. */
export async function readTrackerGitignore(workspace: string): Promise<TrackerGitignoreSnapshot> {
  const file = path.join(await fs.realpath(workspace), '.gitignore');
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Tracker Git visibility requires a regular .gitignore file');
    return { file, text: await fs.readFile(file, 'utf8'), exists: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { file, text: '', exists: false };
    throw error;
  }
}

function addition(text: string): string {
  const lines = text.split(/\r?\n/);
  const starts = lines.flatMap((line, index) => line === begin ? [index] : []);
  const ends = lines.flatMap((line, index) => line === end ? [index] : []);
  if (starts.length || ends.length) {
    if (starts.length !== 1 || ends.length !== 1 || ends[0] <= starts[0]
      || lines.slice(starts[0], ends[0] + 1).join('\n') !== block.join('\n')) {
      throw new Error('The Nimbalyst file tracker block in .gitignore was modified. Review it before saving Files mode.');
    }
    return '';
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  return `${text && !text.endsWith('\n') ? eol : ''}${text ? eol : ''}${block.join(eol)}${eol}`;
}

/** Append only: never rewrite user rules or truncate concurrent edits. A
 * changed snapshot fails before writing; a concurrent append is retained and
 * reported afterward. Existing managed blocks are verified, not relocated. */
export async function appendTrackerGitignore(snapshot: TrackerGitignoreSnapshot): Promise<void> {
  const append = addition(snapshot.text);
  const current = await readTrackerGitignore(path.dirname(snapshot.file));
  if (current.exists !== snapshot.exists || current.text !== snapshot.text) throw conflict();
  if (!append) return;
  const handle = await fs.open(snapshot.file, snapshot.exists ? 'a+' : 'ax+');
  try {
    // Also verify the opened file. This catches changed content between the
    // path snapshot and open; append mode preserves edits without overwriting.
    if (await handle.readFile('utf8') !== snapshot.text) throw conflict();
    await handle.writeFile(append, 'utf8');
    await handle.sync();
  } finally { await handle.close(); }
  const saved = await readTrackerGitignore(path.dirname(snapshot.file));
  if (saved.text !== snapshot.text + append) throw conflict();
}

/** Files mode is a Git-portable contract, but a non-Git project stays valid.
 * This changes only the workspace .gitignore and never stages or commits. */
export async function ensureFileTrackerGitVisibility(workspace: string): Promise<void> {
  try {
    await exec('git', ['-C', workspace, 'rev-parse', '--show-toplevel'], { env: { ...process.env, LC_ALL: 'C' } });
  } catch (error) {
    if ((error as { stderr?: string }).stderr?.includes('not a git repository')) return;
    throw new Error('Cannot inspect Git rules for file trackers', { cause: error });
  }
  const root = await fs.realpath(workspace);
  await withFileTrackerWrite(path.join(root, '.gitignore'), async () => {
    await appendTrackerGitignore(await readTrackerGitignore(root));
    const candidates = [...probes];
    // A nested rule can target one actual card/schema instead of a whole
    // extension. Check the portable artifacts that already exist as well.
    for (const [directory, extension] of [['trackers', /\.ya?ml$/], ['tracker-comments', /\.jsonl$/]] as const) {
      try {
        for (const file of await fs.readdir(path.join(root, '.nimbalyst', directory), { withFileTypes: true })) {
          if (file.isFile() && extension.test(file.name)) candidates.push(`.nimbalyst/${directory}/${file.name}`);
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    const blocked: string[] = [];
    // Bound argv size on Windows even for projects with many comments files.
    for (let offset = 0; offset < candidates.length; offset += 50) {
      try {
        const result = await exec('git', ['-C', root, 'check-ignore', '--no-index', '--', ...candidates.slice(offset, offset + 50)]);
        blocked.push(...result.stdout.split(/\r?\n/).filter(Boolean));
      } catch (error) {
        if ((error as { code?: number }).code === 1) continue; // No ignored paths.
        throw new Error('Cannot verify Git visibility for file trackers', { cause: error });
      }
    }
    if (blocked.length) throw new Error(`Git still ignores file tracker data: ${blocked.join(', ')}. Check nested .gitignore rules before saving Files mode.`);
  });
}
