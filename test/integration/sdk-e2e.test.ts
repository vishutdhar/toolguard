/**
 * End-to-end integration test: real ToolGuard client + real ToolGuard server (in-memory) + mock OpenAI client.
 *
 * Validates that runAgent() works as one integrated path — SDK client, executor,
 * runner, and server authorization all wired together.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildTestApp } from "../helpers/build-test-app";
import { ToolGuard } from "@toolguard/client";
import { runAgent } from "@toolguard/openai";
import type { GuardedToolMap } from "@toolguard/openai";
import type { FastifyInstance } from "fastify";
import type { DemoSeedResult } from "../../src/demo/seed-data";

let app: FastifyInstance;
let seed: DemoSeedResult;
let baseUrl: string;
let tg: ToolGuard;

// Mock tool implementations — track calls
const toolCalls: Array<{ name: string; args: unknown }> = [];

const tools: GuardedToolMap = {
  post_slack_message: {
    toolguardName: "slack.post_message",
    execute: async (args: unknown) => {
      toolCalls.push({ name: "post_slack_message", args });
      return { ok: true, channel: (args as { channel: string }).channel };
    },
    extractContext: (args: { channel: string }) => ({
      context: { justification: `Post to #${args.channel}` },
      payloadSummary: { channelType: "internal" },
    }),
  },
  send_email: {
    toolguardName: "gmail.send_email",
    execute: async (args: unknown) => {
      toolCalls.push({ name: "send_email", args });
      return { ok: true, messageId: "msg_e2e" };
    },
    extractContext: (args: { to: string }) => ({
      context: { justification: "Send customer update" },
      payloadSummary: { recipientDomain: args.to.split("@")[1] ?? "unknown" },
    }),
  },
  issue_refund: {
    toolguardName: "stripe.refund",
    execute: async (args: unknown) => {
      toolCalls.push({ name: "issue_refund", args });
      return { ok: true, refundId: "re_e2e" };
    },
    extractContext: (args: { amountUsd: number }) => ({
      context: { justification: "Customer refund" },
      payloadSummary: { amountUsd: args.amountUsd },
    }),
  },
};

const openaiTools = [
  {
    type: "function" as const,
    function: {
      name: "post_slack_message",
      description: "Post a Slack message",
      parameters: {
        type: "object",
        properties: {
          channel: { type: "string" },
          message: { type: "string" },
        },
        required: ["channel", "message"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "send_email",
      description: "Send an email",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string" },
          subject: { type: "string" },
          body: { type: "string" },
        },
        required: ["to", "subject", "body"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "issue_refund",
      description: "Issue a refund",
      parameters: {
        type: "object",
        properties: {
          paymentId: { type: "string" },
          amountUsd: { type: "number" },
          reason: { type: "string" },
        },
        required: ["paymentId", "amountUsd", "reason"],
      },
    },
  },
];

// --- Mock OpenAI client ---

function createMockOpenAI(responses: Array<{
  content?: string;
  tool_calls?: Array<{ name: string; args: Record<string, unknown> }>;
}>) {
  let callIndex = 0;
  return {
    chat: {
      completions: {
        create: async () => {
          const resp = responses[callIndex++];
          if (!resp) return { choices: [] };

          if (resp.tool_calls) {
            return {
              choices: [{
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: resp.tool_calls.map((tc, i) => ({
                    id: `call_${callIndex}_${i}`,
                    type: "function",
                    function: { name: tc.name, arguments: JSON.stringify(tc.args) },
                  })),
                },
              }],
            };
          }

          return {
            choices: [{
              message: {
                role: "assistant",
                content: resp.content ?? "",
                tool_calls: undefined,
              },
            }],
          };
        },
      },
    },
  };
}

// --- Setup ---

beforeAll(async () => {
  const built = await buildTestApp();
  app = built.app;
  seed = built.seed;

  // Start the server on a random port
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  baseUrl = address;

  tg = new ToolGuard({
    apiKey: seed.rawApiKey,
    baseUrl,
    orgId: seed.organizationId,
    agentId: seed.agentId,
  });
});

afterAll(async () => {
  await app.close();
});

describe("SDK end-to-end integration", () => {
  it("full agent loop: Slack allowed, Gmail requires approval, refund denied", async () => {
    toolCalls.length = 0;

    // Create session and run through SDK client
    const session = await tg.createSession({
      environment: "production",
      scopes: ["slack:write", "gmail:send", "stripe:refund"],
      userId: "e2e_test_user",
    });
    expect(session.id).toBeTruthy();

    const run = await tg.createRun({
      sessionId: session.id,
      promptSummary: "E2E integration test",
    });
    expect(run.id).toBeTruthy();

    // Mock OpenAI: model calls all 3 tools, then responds with summary
    const mockOpenAI = createMockOpenAI([
      // Iteration 1: model calls all 3 tools
      {
        tool_calls: [
          { name: "post_slack_message", args: { channel: "support-internal", message: "Handling ticket" } },
          { name: "send_email", args: { to: "jane@example.com", subject: "Update", body: "We're on it" } },
          { name: "issue_refund", args: { paymentId: "pi_abc123", amountUsd: 1500, reason: "Damaged product" } },
        ],
      },
      // Iteration 2: model sees results and produces final text
      { content: "Handled: Slack posted, email needs approval, refund denied." },
    ]);

    const result = await runAgent({
      openai: mockOpenAI as never,
      toolguard: tg as never,
      messages: [
        { role: "system", content: "You are a support agent." },
        { role: "user", content: "Handle ticket #4821" },
      ],
      openaiTools,
      tools,
      sessionId: session.id,
      runId: run.id,
    });

    // --- Verify agent loop completed ---
    expect(result.iterations).toBe(2);
    expect(result.message).toBe("Handled: Slack posted, email needs approval, refund denied.");

    // --- Verify tool execution results ---
    // Slack: allowed (policy matches channelType=internal) → tool was executed
    expect(toolCalls.some((c) => c.name === "post_slack_message")).toBe(true);

    // Gmail: require_approval (policy matches production + external_email) → tool NOT executed
    expect(toolCalls.some((c) => c.name === "send_email")).toBe(false);

    // Refund: denied (policy matches amountUsd > 1000) → tool NOT executed
    expect(toolCalls.some((c) => c.name === "issue_refund")).toBe(false);

    // --- Verify tool results fed back to model ---
    const toolMessages = result.messages.filter((m) => m.role === "tool");
    expect(toolMessages).toHaveLength(3);

    // Check each tool result content
    const slackResult = JSON.parse((toolMessages[0] as { content: string }).content);
    expect(slackResult.ok).toBe(true);

    const emailResult = JSON.parse((toolMessages[1] as { content: string }).content);
    expect(emailResult.error).toContain("approval");

    const refundResult = JSON.parse((toolMessages[2] as { content: string }).content);
    expect(refundResult.error).toContain("denied");

    // --- Verify replay captures events ---
    await tg.completeRun(run.id, "completed");
    const timeline = await tg.replay(run.id);
    expect(timeline.length).toBeGreaterThanOrEqual(5); // run.started + 3 authorizations + run.completed
  });

  it("authorization failure returns structured error, does not crash loop", async () => {
    toolCalls.length = 0;

    const session = await tg.createSession({
      environment: "production",
      scopes: ["slack:write"],
      userId: "e2e_error_test",
    });

    // Create a separate ToolGuard client with a bad API key
    const badTg = new ToolGuard({
      apiKey: "tg_invalid_key_for_testing",
      baseUrl,
      orgId: seed.organizationId,
      agentId: seed.agentId,
    });

    const mockOpenAI = createMockOpenAI([
      { tool_calls: [{ name: "post_slack_message", args: { channel: "test", message: "hi" } }] },
      { content: "Tool call failed due to auth error." },
    ]);

    // runAgent should NOT throw even though authorization will fail with 401
    const result = await runAgent({
      openai: mockOpenAI as never,
      toolguard: badTg as never,
      messages: [{ role: "user", content: "Post to slack" }],
      openaiTools,
      tools,
      sessionId: session.id,
    });

    expect(result.iterations).toBe(2);

    // The tool result should contain the authorization error, not crash
    const toolMessage = result.messages.find((m) => m.role === "tool");
    const content = JSON.parse((toolMessage as { content: string }).content);
    expect(content.error).toContain("Authorization check failed");

    // Tool should NOT have been executed
    expect(toolCalls).toHaveLength(0);
  });

  it("SDK client methods work end-to-end against live server", async () => {
    // health (no auth required)
    const noAuthClient = new ToolGuard({ baseUrl });
    const health = await noAuthClient.health();
    expect(health.status).toBe("ok");

    // listTools
    const serverTools = await tg.listTools();
    expect(serverTools.length).toBe(5);
    expect(serverTools.map((t) => t.name)).toContain("slack.post_message");

    // listAgents
    const agents = await tg.listAgents();
    expect(agents.length).toBeGreaterThanOrEqual(1);

    // checkUsage
    const usage = await tg.checkUsage({ toolName: "slack.post_message" });
    expect(usage.allowed).toBe(true);
    expect(usage.limits.remainingActionsToday).toBeGreaterThan(0);

    // evaluatePolicy (dry-run, no side effects)
    const session = await tg.createSession({
      environment: "production",
      scopes: ["slack:write"],
      userId: "e2e_eval_test",
    });

    const evalResult = await tg.evaluatePolicy({
      sessionId: session.id,
      tool: { name: "slack.post_message" },
      context: {},
      payloadSummary: { channelType: "internal" },
    });
    expect(evalResult.decision).toBe("allow");
    expect(evalResult.limits).toBeDefined();
  });
});
