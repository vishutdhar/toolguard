import type { ToolGuard } from "@toolguard/client";
import type OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions.js";
import { createGuardedExecutor } from "./executor.js";
import type { ExecutorOptions, GuardedToolMap } from "./types.js";

export interface RunAgentOptions extends ExecutorOptions {
  /** OpenAI client instance */
  openai: OpenAI;
  /** ToolGuard client instance */
  toolguard: ToolGuard;
  /** OpenAI model to use (default: gpt-4o) */
  model?: string;
  /** Initial messages for the conversation */
  messages: ChatCompletionMessageParam[];
  /** OpenAI tool definitions (JSON schemas) */
  openaiTools: ChatCompletionTool[];
  /** Map of OpenAI function names to ToolGuard-guarded implementations */
  tools: GuardedToolMap;
  /** ToolGuard session ID */
  sessionId: string;
  /** Maximum agent loop iterations (default: 10) */
  maxIterations?: number;
}

export interface RunAgentResult {
  /** The final assistant message */
  message: string;
  /** Full conversation history including tool calls */
  messages: ChatCompletionMessageParam[];
  /** Number of loop iterations used */
  iterations: number;
}

/**
 * Runs an OpenAI agent loop with ToolGuard authorization on every tool call.
 *
 * The loop:
 * 1. Sends messages to OpenAI
 * 2. If the model returns tool calls, each one is authorized through ToolGuard
 * 3. Authorized calls are executed; denied calls return error messages to the model
 * 4. Tool results are appended and the loop repeats
 * 5. Stops when the model returns a text response (no tool calls) or maxIterations is reached
 */
export async function runAgent(options: RunAgentOptions): Promise<RunAgentResult> {
  const {
    openai,
    toolguard,
    model = "gpt-4o",
    openaiTools,
    tools,
    sessionId,
    maxIterations = 10,
  } = options;

  const execute = createGuardedExecutor(toolguard, sessionId, tools, {
    runId: options.runId,
    onDenied: options.onDenied,
    onApprovalRequired: options.onApprovalRequired,
  });

  const messages: ChatCompletionMessageParam[] = [...options.messages];
  let iterations = 0;

  while (iterations < maxIterations) {
    const response = await openai.chat.completions.create({
      model,
      messages,
      tools: openaiTools,
    });

    const choice = response.choices[0];
    if (!choice) {
      break;
    }

    const message = choice.message;
    messages.push(message);

    if (!message.tool_calls?.length) {
      return {
        message: message.content ?? "",
        messages,
        iterations: iterations + 1,
      };
    }

    for (const toolCall of message.tool_calls) {
      const result = await execute(toolCall);
      messages.push({
        role: "tool" as const,
        tool_call_id: toolCall.id,
        content: result,
      });
    }

    iterations++;
  }

  const lastMessage = messages[messages.length - 1];
  const content =
    lastMessage && "content" in lastMessage && typeof lastMessage.content === "string"
      ? lastMessage.content
      : "";

  return {
    message: content,
    messages,
    iterations,
  };
}
