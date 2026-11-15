export interface CodexWorkspaceChoice {
  id: string;
  name: string;
}

export interface CodexWorkspaceStatus {
  independent: boolean;
  selectedId: string | null;
  choices: CodexWorkspaceChoice[];
  signingIn: boolean;
  /** Brief hint shared by all windows; the browser attempt may remain pending after it hides. */
  signInHintVisible?: boolean;
  error?: string;
  authenticated?: boolean;
  email?: string | null;
  canSwitch?: boolean;
  selectedName?: string | null;
}
