/** Approval is process-scoped; credentials are never taken from environment variables. */
export function openAIAccessAllowed({ packaged, env }: {
    packaged: boolean;
    env: Record<string, string | undefined>;
}): boolean {
    const explicit = env.NIMBALYST_ALLOW_OPENAI_API;
    if (explicit !== undefined)
        return explicit === '1';
    if (env.VITEST || env.PLAYWRIGHT === '1' || env.PLAYWRIGHT_TEST || env.CI && env.CI !== 'false' || env.NODE_ENV === 'test')
        return false;
    return packaged;
}
/** Network-boundary defense for explicit/cached credentials and standalone callers. */
export function assertOpenAIRequestAllowed(): void {
    const env = typeof process === 'undefined' ? {} : process.env;
    if (!openAIAccessAllowed({ packaged: env.NODE_ENV !== 'development', env }))
        throw Object.assign(new Error('OpenAI API access is disabled for this launch.'), { code: 'OPENAI_ACCESS_DISABLED' });
}
