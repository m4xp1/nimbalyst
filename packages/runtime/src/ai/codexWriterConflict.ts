/** Match the Codex resume failure, not ordinary assistant prose about writers. */
export function isCodexWriterConflict(text: string): boolean {
  return text.includes('[CodexAppServer]') && /thread\/resume failed/i.test(text)
    && /already has an active writer/i.test(text);
}
