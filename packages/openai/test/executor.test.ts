import { describe, it, expect, vi, beforeEach } from "vitest";
import { createGuardedExecutor } from "../src/executor.js";
import type { GuardedToolMap } from "../src/types.js";

// Minimal ToolGuard client mock
function createMockClient(decision: "allow" | "deny" | "require_approval" = "allow") {
  return {
    authorize: vi.fn().mockResolvedValue({
      decision,
      reasonCodes: decision === "deny" ? ["POLICY_DENIED"] : [],
      allowed: decision === "allow",
      denied: decision === "deny",
      pendingApproval: decision === "require_approval",
      approvalId: decision === "require_approval" ? "apr_123" : null,
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

function createToolCall(name: string, args: Record<string, unknown>) {
  return {
    id: "call_abc",
    type: "function" as const,
    function: { name, arguments: JSON.stringify(args) },
  };
}

const tools: GuardedToolMap = {
  send_email: {
    toolguardName: "gmail.send_email",
    execute: vi.fn().mockResolvedValue({ ok: true, messageId: "msg_1" }),
    extractContext: (args: { to: string }) => ({
      context: { justification: "test" },
      payloadSummary: { domain: args.to.split("@")[1] },
    }),
  },
  post_slack: {
    toolguardName: "slack.post_message",
    execute: vi.fn().mockResolvedValue({ ok: true }),
  },
};

describe("createGuardedExecutor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("executes tool when authorized (allow)", async () => {
    const client = createMockClient("allow");
    const execute = createGuardedExecutor(client as never, "sess_1", tools);

    const result = await execute(createToolCall("send_email", { to: "user@example.com" }));
    const parsed = JSON.parse(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.messageId).toBe("msg_1");
    expect(tools.send_email.execute).toHaveBeenCalledWith({ to: "user@example.com" });
  });

  it("passes extractContext output to authorize", async () => {
    const client = createMockClient("allow");
    const execute = createGuardedExecutor(client as never, "sess_1", tools);

    await execute(createToolCall("send_email", { to: "user@example.com" }));

    expect(client.authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess_1",
        tool: { name: "gmail.send_email" },
        context: { justification: "test" },
        payloadSummary: { domain: "example.com" },
      }),
    );
  });

  it("does not execute tool when denied", async () => {
    const client = createMockClient("deny");
    const execute = createGuardedExecutor(client as never, "sess_1", tools);

    const result = await execute(createToolCall("send_email", { to: "x@y.com" }));
    const parsed = JSON.parse(result);

    expect(parsed.error).toContain("denied");
    expect(parsed.reasons).toContain("POLICY_DENIED");
    expect(tools.send_email.execute).not.toHaveBeenCalled();
  });

  it("returns pending status when approval required", async () => {
    const client = createMockClient("require_approval");
    const execute = createGuardedExecutor(client as never, "sess_1", tools);

    const result = await execute(createToolCall("send_email", { to: "x@y.com" }));
    const parsed = JSON.parse(result);

    expect(parsed.status).toBe("pending");
    expect(parsed.approvalId).toBe("apr_123");
    expect(tools.send_email.execute).not.toHaveBeenCalled();
  });

  it("calls onDenied callback when denied", async () => {
    const client = createMockClient("deny");
    const onDenied = vi.fn();
    const execute = createGuardedExecutor(client as never, "sess_1", tools, { onDenied });

    await execute(createToolCall("send_email", { to: "x@y.com" }));

    expect(onDenied).toHaveBeenCalledWith("send_email", ["POLICY_DENIED"]);
  });

  it("calls onApprovalRequired callback when pending", async () => {
    const client = createMockClient("require_approval");
    const onApprovalRequired = vi.fn();
    const execute = createGuardedExecutor(client as never, "sess_1", tools, { onApprovalRequired });

    await execute(createToolCall("send_email", { to: "x@y.com" }));

    expect(onApprovalRequired).toHaveBeenCalledWith("send_email", "apr_123");
  });

  it("returns error for unknown tool name", async () => {
    const client = createMockClient("allow");
    const execute = createGuardedExecutor(client as never, "sess_1", tools);

    const result = await execute(createToolCall("unknown_tool", {}));
    const parsed = JSON.parse(result);

    expect(parsed.error).toContain("Unknown tool");
    expect(client.authorize).not.toHaveBeenCalled();
  });

  it("returns error for invalid JSON arguments", async () => {
    const client = createMockClient("allow");
    const execute = createGuardedExecutor(client as never, "sess_1", tools);

    const toolCall = {
      id: "call_bad",
      type: "function" as const,
      function: { name: "send_email", arguments: "not-json{" },
    };

    const result = await execute(toolCall);
    const parsed = JSON.parse(result);

    expect(parsed.error).toContain("parse");
  });

  it("works without extractContext (optional)", async () => {
    const client = createMockClient("allow");
    const execute = createGuardedExecutor(client as never, "sess_1", tools);

    await execute(createToolCall("post_slack", { channel: "general" }));

    expect(client.authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: { name: "slack.post_message" },
        context: undefined,
        payloadSummary: undefined,
      }),
    );
    expect(tools.post_slack.execute).toHaveBeenCalledWith({ channel: "general" });
  });

  it("passes runId to authorize when provided", async () => {
    const client = createMockClient("allow");
    const execute = createGuardedExecutor(client as never, "sess_1", tools, { runId: "run_42" });

    await execute(createToolCall("post_slack", { channel: "test" }));

    expect(client.authorize).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run_42" }),
    );
  });

  it("returns structured error when authorize call fails (network/401/500)", async () => {
    const client = {
      authorize: vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:3000")),
    };
    const execute = createGuardedExecutor(client as never, "sess_1", tools);

    const result = await execute(createToolCall("send_email", { to: "x@y.com" }));
    const parsed = JSON.parse(result);

    expect(parsed.error).toContain("Authorization check failed");
    expect(parsed.error).toContain("ECONNREFUSED");
    expect(tools.send_email.execute).not.toHaveBeenCalled();
  });

  it("returns structured error when authorize throws non-Error", async () => {
    const client = {
      authorize: vi.fn().mockRejectedValue("server timeout"),
    };
    const execute = createGuardedExecutor(client as never, "sess_1", tools);

    const result = await execute(createToolCall("post_slack", { channel: "test" }));
    const parsed = JSON.parse(result);

    expect(parsed.error).toContain("Authorization check failed");
    expect(parsed.error).toContain("server timeout");
  });

  it("handles tool execution errors gracefully", async () => {
    const client = createMockClient("allow");
    const failTools: GuardedToolMap = {
      fail_tool: {
        toolguardName: "test.fail",
        execute: vi.fn().mockRejectedValue(new Error("DB connection lost")),
      },
    };
    const execute = createGuardedExecutor(client as never, "sess_1", failTools);

    const result = await execute(createToolCall("fail_tool", {}));
    const parsed = JSON.parse(result);

    expect(parsed.error).toContain("DB connection lost");
  });
});
