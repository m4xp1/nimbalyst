import { describe, expect, it, vi } from 'vitest';
import { buildTemporaryCommitPrompt } from '../temporaryCommitPrompt';

describe('temporary Smart Commit context', () => {
  it('passes only scoped files and bounds the JSON-escaped diff', async () => {
    const files = Array.from({ length: 40 }, (_, index) => ({
      path: `docs/file-${index}.md`, status: 'modified' as const,
    }));
    const readDiff = vi.fn(async () => ({ unifiedDiff: '\u0000'.repeat(16_000), isBinary: false }));

    const prompt = await buildTemporaryCommitPrompt(files, readDiff);
    const records = prompt.split('\n').slice(3).map(line => JSON.parse(line));
    expect(records.map(record => record.path)).toEqual(files.map(file => file.path));
    expect(records.every(record => record.truncated === true)).toBe(true);
    expect(prompt.length).toBeLessThan(100_000);
    expect(readDiff.mock.calls.length).toBeLessThan(files.length);
  });

  it('rejects a file whose change disappeared before collecting the proposal', async () => {
    await expect(buildTemporaryCommitPrompt(
      [{ path: 'docs/file.md', status: 'modified' }],
      async () => ({ unifiedDiff: '', isBinary: false }),
    )).rejects.toThrow('No current Git diff');
  });
});
