import path from 'node:path';
import { realpathSync, statSync } from 'node:fs';

type SettingsReader = (workspacePath: string) => Promise<{ permissions: { additionalDirectories?: string[] } }>;

/** Explicit permissions add agent access, not explorer/search roots. */
export async function loadCodexAdditionalDirectories(
  workspacePath: string,
  automaticDirectories: string[],
  readSettings: SettingsReader,
): Promise<string[]> {
  const settings = await readSettings(workspacePath);
  const configured = settings.permissions.additionalDirectories ?? [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const [directories, explicit] of [[automaticDirectories, false], [configured, true]] as const) {
    for (const entry of directories) {
      if (typeof entry !== 'string' || !entry.trim() || entry.includes('\0')) {
        throw new Error('Invalid Codex Additional Directory: expected a directory path.');
      }
      let directory = path.resolve(workspacePath, entry);
      try {
        if (!statSync(directory).isDirectory()) throw new Error('not a directory');
        directory = realpathSync.native(directory);
      } catch (error) {
        if (explicit || !['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) {
          throw new Error('Cannot use Codex Additional Directory ' + directory + ': ' + String(error));
        }
      }
      const key = process.platform === 'win32' ? directory.toLowerCase() : directory;
      if (!seen.has(key)) { seen.add(key); result.push(directory); }
    }
  }
  return result;
}
