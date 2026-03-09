export interface GuardedTool<TArgs = unknown> {
  /** ToolGuard tool name (e.g., 'gmail.send_email') */
  toolguardName: string;
  /** Function to execute when ToolGuard authorizes the call */
  execute: (args: TArgs) => Promise<unknown>;
  /** Extract ToolGuard context from the OpenAI function arguments */
  extractContext?: (args: TArgs) => {
    context?: Record<string, unknown>;
    payloadSummary?: Record<string, unknown>;
    tokenCount?: number;
  };
}

export type GuardedToolMap = Record<string, GuardedTool>;

export interface ExecutorOptions {
  runId?: string;
  onDenied?: (toolName: string, reasons: string[]) => void;
  onApprovalRequired?: (toolName: string, approvalId: string) => void;
}
