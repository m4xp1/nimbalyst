/** Project policy, deliberately separate from builtin tracker field schemas. */
export interface FileTrackerStorageConfig {
  version: 1;
  mode: 'database' | 'files';
  directories: Record<string, string>;
}

export const FILE_TRACKER_CONFIG_PATH = '.nimbalyst/tracker-storage.yaml';

export function parseFileTrackerStorageConfig(value: unknown): FileTrackerStorageConfig {
  if (value === undefined) return { version: 1, mode: 'database', directories: {} };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid tracker storage configuration');
  const input = value as Record<string, unknown>;
  if (input.version !== 1) throw new Error('Unsupported tracker storage format version');
  if (input.mode !== 'files' && input.mode !== 'database') throw new Error('Invalid tracker storage mode');
  if (!input.directories || typeof input.directories !== 'object' || Array.isArray(input.directories)) throw new Error('Tracker directories must be a type-to-path mapping');
  const directories: Record<string, string> = {};
  for (const [type, directory] of Object.entries(input.directories)) {
    if (!/^[a-z][a-z0-9-]*$/.test(type)) throw new Error(`Invalid tracker type: ${type}`);
    if (typeof directory !== 'string' || !directory || /[\\:\u0000-\u001f]/.test(directory)
      || directory.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git' || /[. ]$/.test(part))) {
      throw new Error(`Tracker directory for ${type} must be a portable relative path`);
    }
    directories[type] = directory;
  }
  return { version: 1, mode: input.mode, directories };
}

export function resolveTrackerDirectory(config: FileTrackerStorageConfig, type: string): string {
  const directory = config.directories[type];
  if (!directory) throw new Error(`Configure a directory for tracker type '${type}' before creating a file card`);
  return directory;
}
