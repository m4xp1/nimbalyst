/** Native slash commands and memory notes require a real first keystroke. */
export function isClaudeCliTuiTrigger(prompt: string, attachmentCount: number): boolean {
  const first = prompt.trimStart()[0];
  return attachmentCount === 0 && (first === '/' || first === '#');
}
