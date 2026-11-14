export interface CodexWorkspaceChoice {
  id: string;
  name: string;
}

export interface CodexWorkspaceStatus {
  independent: boolean;
  selectedId: string | null;
  choices: CodexWorkspaceChoice[];
  signingIn: boolean;
  error?: string;
  authenticated?: boolean;
  email?: string | null;
  canSwitch?: boolean;
  selectedName?: string | null;
}
