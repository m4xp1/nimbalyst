/** Merge concurrent input panels, but never retain a completed skills snapshot.
 * Each later opening re-reads effective Codex/plugin configuration for its cwd.
 */
export class CodexWorkflowDiscovery {
  private readonly pending = new Map<string, Promise<string[]>>();

  constructor(
    private readonly exportSkills: (workspacePath: string) => Promise<void>,
    private readonly readSkills: (workspacePath: string) => Promise<string[]>,
  ) {}

  get(workspacePath: string): Promise<string[]> {
    const existing = this.pending.get(workspacePath);
    if (existing) return existing;
    const request = (async () => {
      await this.exportSkills(workspacePath);
      return this.readSkills(workspacePath);
    })().finally(() => { this.pending.delete(workspacePath); });
    this.pending.set(workspacePath, request);
    return request;
  }
}
