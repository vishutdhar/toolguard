import type { ToolGuard } from "@toolguard/client";
import type { ChatCompletionMessageToolCall } from "openai/resources/chat/completions.js";
import type { ExecutorOptions, GuardedToolMap } from "./types.js";

/**
 * Creates a function that authorizes and executes OpenAI tool calls through ToolGuard.
 *
 * For each tool call:
 * - Maps the OpenAI function name to a ToolGuard tool name
 * - Calls ToolGuard to check authorization
 * - If allowed, executes the tool and returns the result
 * - If denied, returns an error message (the model sees it and adapts)
 * - If approval required, returns a pending message with the approval ID
 */
export function createGuardedExecutor(
  client: ToolGuard,
  sessionId: string,
  tools: GuardedToolMap,
  options: ExecutorOptions = {},
): (toolCall: ChatCompletionMessageToolCall) => Promise<string> {
  return async (toolCall: ChatCompletionMessageToolCall): Promise<string> => {
    const mapping = tools[toolCall.function.name];
    if (!mapping) {
      return JSON.stringify({
        error: `Unknown tool: ${toolCall.function.name}. Available tools: ${Object.keys(tools).join(", ")}`,
      });
    }

    let args: unknown;
    try {
      args = JSON.parse(toolCall.function.arguments);
    } catch {
      return JSON.stringify({ error: "Failed to parse tool arguments" });
    }

    const extracted = mapping.extractContext?.(args) ?? {};

    let decision;
    try {
      decision = await client.authorize({
        sessionId,
        runId: options.runId,
        tool: { name: mapping.toolguardName },
        context: extracted.context,
        payloadSummary: extracted.payloadSummary,
        tokenCount: extracted.tokenCount,
      });
    } catch (err) {
      return JSON.stringify({
        error: `Authorization check failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    if (decision.denied) {
      options.onDenied?.(toolCall.function.name, decision.reasonCodes);
      return JSON.stringify({
        error: "This tool call was denied by the authorization policy.",
        reasons: decision.reasonCodes,
      });
    }

    if (decision.pendingApproval) {
      options.onApprovalRequired?.(toolCall.function.name, decision.approvalId!);
      return JSON.stringify({
        error: "This tool call requires human approval before it can proceed.",
        approvalId: decision.approvalId,
        status: "pending",
      });
    }

    try {
      const result = await mapping.execute(args);
      return JSON.stringify(result ?? { success: true });
    } catch (err) {
      return JSON.stringify({
        error: `Tool execution failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };
}
