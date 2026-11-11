// Git-installed fork entry. Keep plugin location explicit, rather than executing the public npm CLI.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMcp } from '../commands/mcp.js';
import { resolvePluginWorkspace } from './pluginWorkspace.js';
import { detectPluginInstall, startUpdateCheck } from './updateCheck.js';
declare const __NIM_VERSION__: string;
const pluginRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const workspace = resolvePluginWorkspace(process.env, process.cwd(), pluginRoot);
const webDir = path.join(pluginRoot, 'web');
const flags: Record<string, string> = existsSync(path.join(webDir, 'index.html')) ? { workspace, assets: webDir } : { workspace };
const install = detectPluginInstall(process.env, process.cwd(), pluginRoot);
const check = install ? startUpdateCheck({ install }) : null;
runMcp(__NIM_VERSION__, { noun: 'mcp', positionals: [], flags }, { takeNotice: check?.takeNotice,
  install: install ?? { kind: 'unmanaged', reason: 'checkout' }, executable: fileURLToPath(import.meta.url) }).catch(error => {
  process.stderr.write(`nimbalyst-local: ${error instanceof Error ? error.stack : error}\n`);
  process.exitCode = 1;
});
