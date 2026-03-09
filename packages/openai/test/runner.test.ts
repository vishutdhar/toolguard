import { describe, it, expect, vi, beforeEach } from "vitest";
import { runAgent } from "../src/runner.js";
import type { GuardedToolMap } from "../src/types.js";

// --- Helpers ---

function createMockToolguard(decision: "allow" | "deny" = "allow") {
  return {
    authorize: vi.fn().mockResolvedValue({
      decision,
      reasonCodes: decision === "deny" ? ["DENIED"] : [],
      allowed: decision === "allow",
      denied: decision === "deny",
      pendingApproval: false,
      approvalId: null,
      policyVersionId: null,
      matchedRuleIndex: null,
      approvalStatus: null,
      limits: {
        remainingActionsToday: 100,
        remainingBudgetUsd: 50,
        remainingToolActionsToday: 100,
        remainingTokensToday: 10000,
      },
    }),
  };
}

function textResponse(content: string) {
  return {
    choices: [
      {
        message: {
          role: "assistant" as const,
          content,
          tool_calls: undefined,
        },
      },
    ],
  };
}

function toolCallResponse(calls: Array<{ name: string; args: Record<string, unknown> }>) {
  return {
    choices: [
      {
        message: {
          role: "assistant" as const,
          content: null,
          tool_calls: calls.map((c, i) => ({
            id: `call_${i}`,
            type: "function" as const,
            function: { name: c.name, arguments: JSON.stringify(c.args) },
          })),
        },
      },
    ],
  };
}

function emptyResponse() {
  return { choices: [] };
}

const tools: GuardedToolMap = {
  get_weather: {
    toolguardName: "weather.get",
    execute: vi.fn().mockResolvedValue({ temp: 72, unit: "F" }),
  },
  send_email: {
    toolguardName: "gmail.send_email",
    execute: vi.fn().mockResolvedValue({ ok: true }),
  },
};

const openaiTools = [
  {
    type: "function" as const,
    function: {
      name: "get_weather",
      description: "Get weather",
      parameters: { type: "object", properties: { city: { type: "string" } } },
    },
  },
];

describe("runAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns text response when model does not call tools", async () => {
    const openai = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue(textResponse("Hello, how can I help?")),
        },
      },
    };

    const result = await runAgent({
      openai: openai as never,
      toolguard: createMockToolguard() as never,
      messages: [{ role: "user", content: "Hi" }],
      openaiTools,
      tools,
      sessionId: "sess_1",
    });

    expect(result.message).toBe("Hello, how can I help?");
    expect(result.iterations).toBe(1);
    expect(result.messages).toHaveLength(2); // user + assistant
  });

  it("executes tool call and feeds result back to model", async () => {
    const openai = {
      chat: {
        completions: {
          create: vi
            .fn()
            .mockResolvedValueOnce(
              toolCallResponse([{ name: "get_weather", args: { city: "NYC" } }]),
            )
            .mockResolvedValueOnce(textResponse("It's 72F in NYC.")),
        },
      },
    };

    const result = await runAgent({
      openai: openai as never,
      toolguard: createMockToolguard("allow") as never,
      messages: [{ role: "user", content: "What's the weather in NYC?" }],
      openaiTools,
      tools,
      sessionId: "sess_1",
    });

    expect(result.message).toBe("It's 72F in NYC.");
    expect(result.iterations).toBe(2);
    expect(tools.get_weather.execute).toHaveBeenCalledWith({ city: "NYC" });

    // Verify tool result was appended to messages
    const toolMessage = result.messages.find((m) => m.role === "tool");
    expect(toolMessage).toBeDefined();
    expect(JSON.parse((toolMessage as { content: string }).content)).toMatchObject({ temp: 72 });
  });

  it("accumulates messages correctly across iterations", async () => {
    const openai = {
      chat: {
        completions: {
          create: vi
            .fn()
            .mockResolvedValueOnce(
              toolCallResponse([{ name: "get_weather", args: { city: "LA" } }]),
            )
            .mockResolvedValueOnce(textResponse("Done.")),
        },
      },
    };

    const result = await runAgent({
      openai: openai as never,
      toolguard: createMockToolguard() as never,
      messages: [{ role: "user", content: "Weather?" }],
      openaiTools,
      tools,
      sessionId: "sess_1",
    });

    // user, assistant (tool_call), tool (result), assistant (text)
    expect(result.messages).toHaveLength(4);
    expect(result.messages[0]).toMatchObject({ role: "user" });
    expect(result.messages[1]).toMatchObject({ role: "assistant" });
    expect(result.messages[2]).toMatchObject({ role: "tool" });
    expect(result.messages[3]).toMatchObject({ role: "assistant", content: "Done." });
  });

  it("stops at maxIterations", async () => {
    // Model always returns tool calls, never text
    const openai = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue(
            toolCallResponse([{ name: "get_weather", args: { city: "X" } }]),
          ),
        },
      },
    };

    const result = await runAgent({
      openai: openai as never,
      toolguard: createMockToolguard() as never,
      messages: [{ role: "user", content: "Loop" }],
      openaiTools,
      tools,
      sessionId: "sess_1",
      maxIterations: 3,
    });

    expect(result.iterations).toBe(3);
    expect(openai.chat.completions.create).toHaveBeenCalledTimes(3);
  });

  it("handles empty choices array gracefully", async () => {
    const openai = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue(emptyResponse()),
        },
      },
    };

    const result = await runAgent({
      openai: openai as never,
      toolguard: createMockToolguard() as never,
      messages: [{ role: "user", content: "Hi" }],
      openaiTools,
      tools,
      sessionId: "sess_1",
    });

    // When choices is empty, loop breaks immediately; last message is the user input
    expect(result.message).toBe("Hi");
    expect(result.iterations).toBe(0);
  });

  it("handles denied tool call and feeds denial back to model", async () => {
    const openai = {
      chat: {
        completions: {
          create: vi
            .fn()
            .mockResolvedValueOnce(
              toolCallResponse([{ name: "send_email", args: { to: "x@y.com" } }]),
            )
            .mockResolvedValueOnce(textResponse("Sorry, that was denied.")),
        },
      },
    };

    const result = await runAgent({
      openai: openai as never,
      toolguard: createMockToolguard("deny") as never,
      messages: [{ role: "user", content: "Send email" }],
      openaiTools,
      tools,
      sessionId: "sess_1",
    });

    expect(result.message).toBe("Sorry, that was denied.");
    expect(tools.send_email.execute).not.toHaveBeenCalled();

    // The denial error JSON was fed back as a tool result
    const toolMessage = result.messages.find((m) => m.role === "tool");
    const content = JSON.parse((toolMessage as { content: string }).content);
    expect(content.error).toContain("denied");
  });

  it("does not mutate the input messages array", async () => {
    const openai = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue(textResponse("Hi")),
        },
      },
    };

    const original = [{ role: "user" as const, content: "Hello" }];
    const originalLength = original.length;

    await runAgent({
      openai: openai as never,
      toolguard: createMockToolguard() as never,
      messages: original,
      openaiTools,
      tools,
      sessionId: "sess_1",
    });

    expect(original).toHaveLength(originalLength);
  });

  it("passes model parameter to OpenAI", async () => {
    const openai = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue(textResponse("ok")),
        },
      },
    };

    await runAgent({
      openai: openai as never,
      toolguard: createMockToolguard() as never,
      messages: [{ role: "user", content: "Hi" }],
      openaiTools,
      tools,
      sessionId: "sess_1",
      model: "gpt-4o-mini",
    });

    expect(openai.chat.completions.create).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-4o-mini" }),
    );
  });

  it("handles multiple tool calls in a single response", async () => {
    const openai = {
      chat: {
        completions: {
          create: vi
            .fn()
            .mockResolvedValueOnce(
              toolCallResponse([
                { name: "get_weather", args: { city: "NYC" } },
                { name: "get_weather", args: { city: "LA" } },
              ]),
            )
            .mockResolvedValueOnce(textResponse("NYC: 72F, LA: 85F")),
        },
      },
    };

    const result = await runAgent({
      openai: openai as never,
      toolguard: createMockToolguard() as never,
      messages: [{ role: "user", content: "Weather in NYC and LA?" }],
      openaiTools,
      tools,
      sessionId: "sess_1",
    });

    expect(tools.get_weather.execute).toHaveBeenCalledTimes(2);
    const toolMessages = result.messages.filter((m) => m.role === "tool");
    expect(toolMessages).toHaveLength(2);
  });
});
