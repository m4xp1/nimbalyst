export interface CodexSteerTarget {
  supported: boolean;
  turnId: string | null;
}

export interface CodexSteerRequest {
  sessionId: string;
  workspacePath: string;
  expectedTurnId: string;
  message: string;
  prompt?: string;
  annotations?: readonly unknown[];
}

export type CodexSteerResult =
  | { success: true; turnId: string }
  | {
    success: false;
    error: string;
    code: 'unsupported' | 'no-active-turn' | 'rejected' | 'delivery-unknown';
  };
