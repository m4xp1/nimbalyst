// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { parseFileTrackerStorageConfig, resolveTrackerDirectory } from '../fileTrackerStorageConfig';

describe('portable tracker storage configuration', () => {
  it('defaults to database without manufacturing schema overrides', () => {
    expect(parseFileTrackerStorageConfig(undefined)).toEqual({ version: 1, mode: 'database', directories: {} });
  });
  it('keeps only the storage policy and relative per-type directories', () => {
    const config = parseFileTrackerStorageConfig({ version: 1, mode: 'files', directories: { task: 'docs/work/tasks', decision: 'docs/decisions' } });
    expect(resolveTrackerDirectory(config, 'task')).toBe('docs/work/tasks');
    expect(() => resolveTrackerDirectory(config, 'bug')).toThrow(/directory/i);
  });
  it.each(['../outside', 'docs/../private', 'C:/outside', 'C:relative', '//server/share', '/absolute', 'docs\\tasks', 'docs//tasks', 'docs/.', 'docs\u0000bad'])('rejects non-portable directory %j', directory => {
    expect(() => parseFileTrackerStorageConfig({ version: 1, mode: 'files', directories: { task: directory } })).toThrow();
  });
  it('fails closed on malformed or newer configuration', () => {
    for (const input of [{ version: 2, mode: 'files', directories: {} }, { version: 1, mode: 'unknown' }, { version: 1, mode: 'files', directories: [] }]) {
      expect(() => parseFileTrackerStorageConfig(input)).toThrow();
    }
  });
});
