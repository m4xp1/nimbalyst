// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { ensureFileTrackerGitVisibility, readTrackerGitignore, appendTrackerGitignore } from '../fileTrackerGitVisibility';
import { FileTrackerStore } from '../fileTrackerStore';

const exec = promisify(execFile);
const config = { version: 1, mode: 'files', directories: { task: 'docs/tasks' } };
const portable = ['.nimbalyst/tracker-storage.yaml', '.nimbalyst/trackers/task.patch.yaml', '.nimbalyst/trackers/custom.yml', '.nimbalyst/tracker-comments/card-123.jsonl'];
const privatePaths = ['.nimbalyst/config.json', '.nimbalyst/assets/private.png', '.nimbalyst/tracker-identity/card-123', '.nimbalyst/trackers/task.patch.yaml.123.bak', '.nimbalyst/tracker-comments/card-123.jsonl.tmp'];

describe('portable tracker Git visibility', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'nimbalyst-tracker-git-'));
    await exec('git', ['-C', root, 'init', '--quiet']);
    await writeFile(path.join(root, '.gitignore'), '\uFEFF# Keep my rules\r\n.nimbalyst/\r\nprivate/');
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  const git = (args: string[]) => exec('git', ['-C', root, ...args]);
  async function ignored(paths: string[]) {
    try { return (await git(['check-ignore', '--no-index', '--', ...paths])).stdout.split(/\r?\n/).filter(Boolean); }
    catch (error) { if ((error as { code: number }).code === 1) return []; throw error; }
  }

  it('makes only portable tracker files visible without staging or changing existing rules', async () => {
    const original = await readFile(path.join(root, '.gitignore'), 'utf8');
    const store = new FileTrackerStore(root);
    await store.saveConfig(config, (await store.configSnapshot()).version);
    expect(await ignored(portable)).toEqual([]);
    expect(await ignored(privatePaths)).toEqual(privatePaths);
    const rules = await readFile(path.join(root, '.gitignore'), 'utf8');
    expect(rules.startsWith(original + '\r\n')).toBe(true);
    expect(rules.replace(/\r\n/g, '')).not.toContain('\n');
    expect((await git(['diff', '--cached', '--name-only'])).stdout).toBe('');
    await store.saveConfig({ ...config, mode: 'database' }, (await store.configSnapshot()).version);
    expect(await readFile(path.join(root, '.gitignore'), 'utf8')).toBe(rules);
    await store.saveConfig(config, (await store.configSnapshot()).version);
    expect(await readFile(path.join(root, '.gitignore'), 'utf8')).toBe(rules);
  });

  it('rejects a nested ignore conflict without enabling Files mode', async () => {
    await mkdir(path.join(root, '.nimbalyst'));
    await writeFile(path.join(root, '.nimbalyst/.gitignore'), 'tracker-comments/\n');
    const store = new FileTrackerStore(root);
    const original = await store.configSnapshot();
    await expect(store.saveConfig(config, original.version)).rejects.toThrow(/Git.*tracker-comments/);
    expect(await store.configSnapshot()).toEqual(original);
    expect(await ignored(privatePaths)).toEqual(privatePaths);
  });

  it('detects a parallel edit instead of overwriting it', async () => {
    const snapshot = await readTrackerGitignore(root);
    const concurrent = '# My external edit\n.nimbalyst/\n';
    await writeFile(path.join(root, '.gitignore'), concurrent);
    await expect(appendTrackerGitignore(snapshot)).rejects.toThrow(/gitignore.*changed/i);
    expect(await readFile(path.join(root, '.gitignore'), 'utf8')).toBe(concurrent);
  });

  it('checks existing schema and comment names against specific nested exclusions', async () => {
    await mkdir(path.join(root, '.nimbalyst/tracker-comments'), { recursive: true });
    await writeFile(path.join(root, '.nimbalyst/tracker-comments/card-123.jsonl'), '{"id":"comment-one"}\n');
    await writeFile(path.join(root, '.nimbalyst/.gitignore'), 'tracker-comments/card-123.jsonl\n');
    await expect(ensureFileTrackerGitVisibility(root)).rejects.toThrow(/card-123\.jsonl/);
  });

  it('creates a narrow block when no ignore file exists and rejects an edited block', async () => {
    await rm(path.join(root, '.gitignore'));
    await ensureFileTrackerGitVisibility(root);
    expect(await ignored(portable)).toEqual([]);
    expect(await ignored(privatePaths)).toEqual(privatePaths);
    const modified = (await readFile(path.join(root, '.gitignore'), 'utf8')).replace('!/.nimbalyst/tracker-storage.yaml', '!/.nimbalyst/*');
    await writeFile(path.join(root, '.gitignore'), modified);
    await expect(ensureFileTrackerGitVisibility(root)).rejects.toThrow(/modified/);
    expect(await readFile(path.join(root, '.gitignore'), 'utf8')).toBe(modified);
  });

  it('refuses a stale settings save before touching Git rules', async () => {
    const store = new FileTrackerStore(root);
    const old = await store.configSnapshot();
    await store.saveConfig({ ...config, mode: 'database' }, old.version);
    const rules = await readFile(path.join(root, '.gitignore'), 'utf8');
    await expect(store.saveConfig(config, old.version)).rejects.toThrow(/changed/);
    expect(await readFile(path.join(root, '.gitignore'), 'utf8')).toBe(rules);
  });

  it('serializes simultaneous enable requests without duplicating the block', async () => {
    await Promise.all([ensureFileTrackerGitVisibility(root), ensureFileTrackerGitVisibility(root)]);
    const rules = await readFile(path.join(root, '.gitignore'), 'utf8');
    expect(rules.match(/# BEGIN Nimbalyst file tracker/g)).toHaveLength(1);
    expect(await ignored(portable)).toEqual([]);
  });

  it('scopes the block to a nested workspace and leaves unrelated private files ignored', async () => {
    const workspace = path.join(root, 'nested');
    await mkdir(workspace);
    await ensureFileTrackerGitVisibility(workspace);
    expect(await ignored(portable)).toEqual(portable);
    expect(await ignored(portable.map(file => `nested/${file}`))).toEqual([]);
    expect(await ignored(privatePaths.map(file => `nested/${file}`))).toEqual(privatePaths.map(file => `nested/${file}`));
  });

  it('does not invent Git settings for a folder without a repository', async () => {
    await rm(path.join(root, '.git'), { recursive: true });
    const original = await readFile(path.join(root, '.gitignore'), 'utf8');
    await ensureFileTrackerGitVisibility(root);
    expect(await readFile(path.join(root, '.gitignore'), 'utf8')).toBe(original);
  });
});
