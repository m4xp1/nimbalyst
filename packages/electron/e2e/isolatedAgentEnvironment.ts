import path from 'node:path';

/**
 * A separate Electron userData directory does not isolate CLI accounts.
 * Keep all agent homes under the fixture and discard Codex Desktop routing,
 * credentials and inherited opt-ins. Live-agent acceptance uses its own runner.
 */
export function isolatedAgentEnvironment(
  home: string,
  inherited: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (value === undefined || /^(CODEX_|OPENAI_|ANTHROPIC_|CLAUDE_|CHATGPT_|GH_TOKEN$|GH_ENTERPRISE_TOKEN$|GITHUB_TOKEN$|GITHUB_API_TOKEN$|GITHUB_ENTERPRISE_TOKEN$|ELECTRON_RUN_AS_NODE$|ELECTRON_NO_ATTACH_CONSOLE$|NODE_PATH$)/i.test(key)) continue;
    env[key] = value;
  }
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    HOMEDRIVE: path.parse(home).root.replace(/[\\/]$/, ''),
    HOMEPATH: home.slice(path.parse(home).root.length - 1),
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    CODEX_HOME: path.join(home, '.codex'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    GH_CONFIG_DIR: path.join(home, '.config', 'gh'),
    GH_PROMPT_DISABLED: '1',
    NIMBALYST_ALLOW_CODEX_ACCESS: '0',
    NIMBALYST_ALLOW_OPENAI_API: '0',
  };
}
