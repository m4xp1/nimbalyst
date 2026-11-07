/**
 * Codex ChatGPT/OAuth access is separate from the paid OpenAI API gate.
 * Automated launches are offline unless a dedicated live runner opts in.
 * Never infer permission from an inherited auth file or an existing login.
 */
export const CODEX_ACCESS_DISABLED_MESSAGE = 'Codex account access is disabled for this launch.';

export function codexAccessAllowed(
  env: Record<string, string | undefined> = typeof process === 'undefined' ? {} : process.env,
): boolean {
  const explicit = env.NIMBALYST_ALLOW_CODEX_ACCESS;
  if (explicit !== undefined) return explicit === '1';
  return !(env.VITEST || env.PLAYWRIGHT === '1' || env.PLAYWRIGHT_TEST ||
    env.NODE_ENV === 'test' || (env.CI && env.CI !== 'false'));
}

export function assertCodexAccessAllowed(): void {
  if (!codexAccessAllowed()) {
    throw Object.assign(new Error(CODEX_ACCESS_DISABLED_MESSAGE), { code: 'CODEX_ACCESS_DISABLED' });
  }
}
