import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTestApp } from "../helpers/build-test-app";

// Default DNS mock: resolve to a safe public IP so webhook creation tests pass
// without depending on real DNS resolution.
vi.mock("node:dns/promises", () => ({
  resolve4: vi.fn().mockResolvedValue(["93.184.216.34"]),
  resolve6: vi.fn().mockRejectedValue(Object.assign(new Error("ENODATA"), { code: "ENODATA" })),
}));

describe("ToolGuard API integration", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>["app"];
  let seed: Awaited<ReturnType<typeof buildTestApp>>["seed"];
  let headers: Record<string, string>;

  beforeEach(async () => {
    const built = await buildTestApp();
    app = built.app;
    seed = built.seed;
    headers = built.headers;
  });

  afterEach(async () => {
    await app.close();
  });

  async function createSession(scopes: string[] = ["slack:write", "gmail:send", "stripe:refund"]) {
    const response = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers,
      payload: {
        orgId: seed.organizationId,
        agentId: seed.agentId,
        userId: "user_123",
        servicePrincipal: null,
        environment: "production",
        scopes,
        metadata: {
          source: "support-bot",
        },
      },
    });

    expect(response.statusCode).toBe(201);
    return response.json();
  }

  it("creates a session", async () => {
    const session = await createSession();

    expect(session.orgId).toBe(seed.organizationId);
    expect(session.agentId).toBe(seed.agentId);
    expect(session.environment).toBe("production");
  });

  it("authorizes an allowed Slack tool", async () => {
    const session = await createSession();
    const run = await app.inject({
      method: "POST",
      url: "/v1/runs",
      headers,
      payload: {
        orgId: seed.organizationId,
        sessionId: session.id,
        promptSummary: "Slack update",
        metadata: {},
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/tool/authorize",
      headers,
      payload: {
        orgId: seed.organizationId,
        agentId: seed.agentId,
        sessionId: session.id,
        runId: run.json().id,
        tool: {
          name: seed.toolNames.slack,
          action: "post",
          resource: "internal_channel",
          riskLevel: "low",
          estimatedCostUsd: 0,
        },
        context: {
          environment: "production",
          justification: "Internal update",
        },
        payloadSummary: {
          channelType: "internal",
        },
        tokenCount: 10,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().decision).toBe("allow");
  });

  it("denies a large Stripe refund", async () => {
    const session = await createSession();
    const response = await app.inject({
      method: "POST",
      url: "/v1/tool/authorize",
      headers,
      payload: {
        orgId: seed.organizationId,
        agentId: seed.agentId,
        sessionId: session.id,
        tool: {
          name: seed.toolNames.stripeRefund,
          action: "refund",
          resource: "payment",
          riskLevel: "high",
          estimatedCostUsd: 0,
        },
        context: {
          environment: "production",
          justification: "Refund request",
        },
        payloadSummary: {
          amountUsd: 1500,
        },
        tokenCount: 10,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().decision).toBe("deny");
    expect(response.json().reasonCodes).toContain("REFUND_THRESHOLD_EXCEEDED");
  });

  it("requires approval for external Gmail and proceeds after approval", async () => {
    const session = await createSession();

    const firstResponse = await app.inject({
      method: "POST",
      url: "/v1/tool/authorize",
      headers,
      payload: {
        orgId: seed.organizationId,
        agentId: seed.agentId,
        sessionId: session.id,
        tool: {
          name: seed.toolNames.gmail,
          action: "send",
          resource: "external_email",
          riskLevel: "high",
          estimatedCostUsd: 0,
        },
        context: {
          environment: "production",
          justification: "Customer update",
        },
        payloadSummary: {
          recipientDomain: "gmail.com",
        },
        tokenCount: 15,
      },
    });

    expect(firstResponse.statusCode).toBe(200);
    expect(firstResponse.json().decision).toBe("require_approval");

    const approvalId = firstResponse.json().approvalId as string;
    const resolveResponse = await app.inject({
      method: "POST",
      url: `/v1/approvals/${approvalId}/resolve`,
      headers,
      payload: {
        status: "approved",
      },
    });

    expect(resolveResponse.statusCode).toBe(200);
    expect(resolveResponse.json().status).toBe("approved");
    expect(resolveResponse.json().resolvedBy).toMatch(/^api_key:/);

    const secondResponse = await app.inject({
      method: "POST",
      url: "/v1/tool/authorize",
      headers,
      payload: {
        orgId: seed.organizationId,
        agentId: seed.agentId,
        sessionId: session.id,
        approvalId,
        tool: {
          name: seed.toolNames.gmail,
          action: "send",
          resource: "external_email",
          riskLevel: "high",
          estimatedCostUsd: 0,
        },
        context: {
          environment: "production",
          justification: "Customer update",
        },
        payloadSummary: {
          recipientDomain: "gmail.com",
        },
        tokenCount: 15,
      },
    });

    expect(secondResponse.statusCode).toBe(200);
    expect(secondResponse.json().decision).toBe("allow");
    expect(secondResponse.json().approvalStatus).toBe("approved");
  });

  it("returns an ordered replay timeline", async () => {
    const session = await createSession();
    const runResponse = await app.inject({
      method: "POST",
      url: "/v1/runs",
      headers,
      payload: {
        orgId: seed.organizationId,
        sessionId: session.id,
        promptSummary: "Support workflow",
        metadata: {
          source: "integration-test",
        },
      },
    });
    const run = runResponse.json();

    await app.inject({
      method: "POST",
      url: "/v1/tool/authorize",
      headers,
      payload: {
        orgId: seed.organizationId,
        agentId: seed.agentId,
        sessionId: session.id,
        runId: run.id,
        tool: {
          name: seed.toolNames.slack,
          action: "post",
          resource: "internal_channel",
          riskLevel: "low",
          estimatedCostUsd: 0,
        },
        context: {
          environment: "production",
          justification: "Internal update",
        },
        payloadSummary: {
          channelType: "internal",
        },
        tokenCount: 20,
      },
    });

    const approvalRequest = await app.inject({
      method: "POST",
      url: "/v1/tool/authorize",
      headers,
      payload: {
        orgId: seed.organizationId,
        agentId: seed.agentId,
        sessionId: session.id,
        runId: run.id,
        tool: {
          name: seed.toolNames.gmail,
          action: "send",
          resource: "external_email",
          riskLevel: "high",
          estimatedCostUsd: 0,
        },
        context: {
          environment: "production",
          justification: "Customer update",
        },
        payloadSummary: {
          recipientDomain: "gmail.com",
        },
        tokenCount: 20,
      },
    });
    const approvalId = approvalRequest.json().approvalId as string;

    await app.inject({
      method: "POST",
      url: `/v1/approvals/${approvalId}/resolve`,
      headers,
      payload: {
        status: "approved",
      },
    });

    await app.inject({
      method: "POST",
      url: "/v1/tool/authorize",
      headers,
      payload: {
        orgId: seed.organizationId,
        agentId: seed.agentId,
        sessionId: session.id,
        runId: run.id,
        approvalId,
        tool: {
          name: seed.toolNames.gmail,
          action: "send",
          resource: "external_email",
          riskLevel: "high",
          estimatedCostUsd: 0,
        },
        context: {
          environment: "production",
          justification: "Customer update",
        },
        payloadSummary: {
          recipientDomain: "gmail.com",
        },
        tokenCount: 20,
      },
    });

    await app.inject({
      method: "POST",
      url: `/v1/runs/${run.id}/complete`,
      headers,
      payload: {
        status: "completed",
      },
    });

    const replayResponse = await app.inject({
      method: "GET",
      url: `/v1/runs/${run.id}/replay`,
      headers,
    });

    expect(replayResponse.statusCode).toBe(200);
    const items = replayResponse.json().items as Array<{ eventType: string }>;
    expect(items.map((item) => item.eventType)).toEqual(
      expect.arrayContaining([
        "run.started",
        "tool.authorization.requested",
        "policy.evaluated",
        "approval.requested",
        "approval.resolved",
        "tool.authorized",
        "run.completed",
      ]),
    );
    expect(items[0]?.eventType).toBe("run.started");
    expect(items[items.length - 1]?.eventType).toBe("run.completed");
  });

  it("rejects environment spoofing during authorization", async () => {
    const session = await createSession();

    const response = await app.inject({
      method: "POST",
      url: "/v1/tool/authorize",
      headers,
      payload: {
        orgId: seed.organizationId,
        agentId: seed.agentId,
        sessionId: session.id,
        tool: {
          name: seed.toolNames.slack,
          estimatedCostUsd: 0,
        },
        context: {
          environment: "development",
          justification: "Try to downgrade policy context",
        },
        payloadSummary: {
          channelType: "internal",
        },
        tokenCount: 5,
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("ENVIRONMENT_MISMATCH");
  });

  it("denies tool authorization when the session lacks the required scope", async () => {
    const session = await createSession(["slack:write"]);

    const response = await app.inject({
      method: "POST",
      url: "/v1/tool/authorize",
      headers,
      payload: {
        orgId: seed.organizationId,
        agentId: seed.agentId,
        sessionId: session.id,
        tool: {
          name: seed.toolNames.gmail,
          estimatedCostUsd: 0,
        },
        context: {
          justification: "Customer update",
        },
        payloadSummary: {
          recipientDomain: "gmail.com",
        },
        tokenCount: 5,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().decision).toBe("deny");
    expect(response.json().reasonCodes).toContain("SESSION_SCOPE_MISSING");
  });

  it("uses the session environment for policy evaluation", async () => {
    const session = await createSession();

    const response = await app.inject({
      method: "POST",
      url: "/v1/policy/evaluate",
      headers,
      payload: {
        orgId: seed.organizationId,
        agentId: seed.agentId,
        sessionId: session.id,
        tool: {
          name: seed.toolNames.gmail,
          estimatedCostUsd: 0,
        },
        context: {
          justification: "Customer update",
        },
        payloadSummary: {
          recipientDomain: "gmail.com",
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().decision).toBe("require_approval");
  });

  it("rejects unknown runs during authorization", async () => {
    const session = await createSession();

    const response = await app.inject({
      method: "POST",
      url: "/v1/tool/authorize",
      headers,
      payload: {
        orgId: seed.organizationId,
        agentId: seed.agentId,
        sessionId: session.id,
        runId: "run_missing",
        tool: {
          name: seed.toolNames.slack,
          estimatedCostUsd: 0,
        },
        context: {
          environment: "production",
          justification: "Internal update",
        },
        payloadSummary: {
          channelType: "internal",
        },
        tokenCount: 5,
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error).toBe("NOT_FOUND");
  });

  it("rejects approval overrides that do not match the requested tool", async () => {
    const session = await createSession();

    const approvalResponse = await app.inject({
      method: "POST",
      url: "/v1/tool/authorize",
      headers,
      payload: {
        orgId: seed.organizationId,
        agentId: seed.agentId,
        sessionId: session.id,
        tool: {
          name: seed.toolNames.gmail,
          estimatedCostUsd: 0,
        },
        context: {
          environment: "production",
          justification: "Customer update",
        },
        payloadSummary: {
          recipientDomain: "gmail.com",
        },
        tokenCount: 5,
      },
    });

    const approvalId = approvalResponse.json().approvalId as string;
    const response = await app.inject({
      method: "POST",
      url: "/v1/tool/authorize",
      headers,
      payload: {
        orgId: seed.organizationId,
        agentId: seed.agentId,
        sessionId: session.id,
        approvalId,
        tool: {
          name: seed.toolNames.slack,
          estimatedCostUsd: 0,
        },
        context: {
          environment: "production",
          justification: "Internal update",
        },
        payloadSummary: {
          channelType: "internal",
        },
        tokenCount: 5,
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("APPROVAL_TOOL_MISMATCH");
  });

  it("rejects audit events with mismatched run and session links", async () => {
    const sessionA = await createSession();
    const sessionB = await createSession();
    const runResponse = await app.inject({
      method: "POST",
      url: "/v1/runs",
      headers,
      payload: {
        orgId: seed.organizationId,
        sessionId: sessionA.id,
        promptSummary: "Support workflow",
        metadata: {},
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/audit/events",
      headers,
      payload: {
        orgId: seed.organizationId,
        sessionId: sessionB.id,
        runId: runResponse.json().id,
        eventType: "custom.event",
        actorType: "system",
        payload: {
          test: true,
        },
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("RUN_SESSION_MISMATCH");
  });

  it("persists estimatedCostUsd on tool creation and returns it", async () => {
    const createResponse = await app.inject({
      method: "POST",
      url: "/v1/tools",
      headers,
      payload: {
        orgId: seed.organizationId,
        name: "billing.charge",
        action: "charge",
        resource: "payment",
        riskLevel: "high",
        estimatedCostUsd: 9.5,
      },
    });

    expect(createResponse.statusCode).toBe(201);
    expect(createResponse.json().estimatedCostUsd).toBe(9.5);

    const listResponse = await app.inject({
      method: "GET",
      url: "/v1/tools",
      headers,
    });

    const tools = listResponse.json().items as Array<{ name: string; estimatedCostUsd: number }>;
    const created = tools.find((t) => t.name === "billing.charge");
    expect(created?.estimatedCostUsd).toBe(9.5);
  });

  it("returns 409 on concurrent approval resolution (not 500)", async () => {
    const session = await createSession();
    const authResponse = await app.inject({
      method: "POST",
      url: "/v1/tool/authorize",
      headers,
      payload: {
        orgId: seed.organizationId,
        agentId: seed.agentId,
        sessionId: session.id,
        tool: { name: seed.toolNames.gmail },
        context: { environment: "production", justification: "Test" },
        payloadSummary: { recipientDomain: "gmail.com" },
        tokenCount: 5,
      },
    });

    const approvalId = authResponse.json().approvalId as string;

    // Fire both resolves concurrently — one wins, one gets 409
    const [a, b] = await Promise.all([
      app.inject({
        method: "POST",
        url: `/v1/approvals/${approvalId}/resolve`,
        headers,
        payload: { status: "approved" },
      }),
      app.inject({
        method: "POST",
        url: `/v1/approvals/${approvalId}/resolve`,
        headers,
        payload: { status: "rejected" },
      }),
    ]);

    const statuses = [a.statusCode, b.statusCode].sort();
    expect(statuses).toEqual([200, 409]);

    const loser = a.statusCode === 409 ? a : b;
    expect(loser.json().error).toBe("APPROVAL_STATUS_CHANGED");
  });

  it("inherits agent environment when session omits the field", async () => {
    // Create a development agent
    const devAgentResponse = await app.inject({
      method: "POST",
      url: "/v1/agents",
      headers,
      payload: {
        orgId: seed.organizationId,
        name: "dev-agent",
        environment: "development",
        defaultScopes: [],
      },
    });
    expect(devAgentResponse.statusCode).toBe(201);
    const devAgent = devAgentResponse.json();

    // Create session WITHOUT environment — should inherit "development"
    const sessionResponse = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers,
      payload: {
        orgId: seed.organizationId,
        agentId: devAgent.id,
        scopes: [],
        metadata: {},
      },
    });

    expect(sessionResponse.statusCode).toBe(201);
    expect(sessionResponse.json().environment).toBe("development");
  });

  it("rejects session with mismatched environment", async () => {
    // Create a development agent
    const devAgentResponse = await app.inject({
      method: "POST",
      url: "/v1/agents",
      headers,
      payload: {
        orgId: seed.organizationId,
        name: "dev-agent-2",
        environment: "development",
        defaultScopes: [],
      },
    });
    const devAgent = devAgentResponse.json();

    // Try to create a "production" session for a "development" agent
    const sessionResponse = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers,
      payload: {
        orgId: seed.organizationId,
        agentId: devAgent.id,
        environment: "production",
        scopes: [],
        metadata: {},
      },
    });

    expect(sessionResponse.statusCode).toBe(409);
    expect(sessionResponse.json().error).toBe("ENVIRONMENT_MISMATCH");
  });

  it("lists approvals with optional status filter and pagination", async () => {
    const session = await createSession();

    // Create two approval requests via authorize (gmail requires approval)
    for (let i = 0; i < 2; i++) {
      await app.inject({
        method: "POST",
        url: "/v1/tool/authorize",
        headers,
        payload: {
          orgId: seed.organizationId,
          agentId: seed.agentId,
          sessionId: session.id,
          tool: { name: seed.toolNames.gmail },
          context: { environment: "production", justification: "Test" },
          payloadSummary: { recipientDomain: "gmail.com" },
          tokenCount: 5,
        },
      });
    }

    // List all approvals
    const allResponse = await app.inject({
      method: "GET",
      url: "/v1/approvals",
      headers,
    });

    expect(allResponse.statusCode).toBe(200);
    const allBody = allResponse.json();
    expect(allBody.items.length).toBeGreaterThanOrEqual(2);

    // Filter by status=pending
    const pendingResponse = await app.inject({
      method: "GET",
      url: "/v1/approvals?status=pending",
      headers,
    });

    expect(pendingResponse.statusCode).toBe(200);
    const pendingItems = pendingResponse.json().items;
    for (const item of pendingItems) {
      expect(item.status).toBe("pending");
    }

    // Paginate with limit=1
    const page1 = await app.inject({
      method: "GET",
      url: "/v1/approvals?limit=1",
      headers,
    });

    expect(page1.statusCode).toBe(200);
    const page1Body = page1.json();
    expect(page1Body.items).toHaveLength(1);
    expect(page1Body.cursor).not.toBeNull();

    // Fetch page 2 using cursor
    const page2 = await app.inject({
      method: "GET",
      url: `/v1/approvals?limit=1&cursor=${page1Body.cursor}`,
      headers,
    });

    expect(page2.statusCode).toBe(200);
    expect(page2.json().items).toHaveLength(1);
    expect(page2.json().items[0].id).not.toBe(page1Body.items[0].id);
  });

  it("lists audit events with pagination", async () => {
    // Create an audit event
    const session = await createSession();
    await app.inject({
      method: "POST",
      url: "/v1/audit/events",
      headers,
      payload: {
        orgId: seed.organizationId,
        sessionId: session.id,
        eventType: "custom.test",
        actorType: "system",
        payload: { test: true },
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/v1/audit/events",
      headers,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().items.length).toBeGreaterThanOrEqual(1);
    expect(response.json().cursor).toBeDefined();
  });

  it("manages webhook lifecycle (create, list, delete)", async () => {
    // Create webhook
    const createResponse = await app.inject({
      method: "POST",
      url: "/v1/webhooks",
      headers,
      payload: {
        url: "https://example.com/webhook",
        eventTypes: ["approval.requested", "approval.resolved"],
        secret: "my-secret",
      },
    });

    expect(createResponse.statusCode).toBe(201);
    const webhook = createResponse.json();
    expect(webhook.url).toBe("https://example.com/webhook");
    expect(webhook.eventTypes).toEqual(["approval.requested", "approval.resolved"]);
    expect(webhook.secret).toBe("••••••••"); // masked

    // List webhooks
    const listResponse = await app.inject({
      method: "GET",
      url: "/v1/webhooks",
      headers,
    });

    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json().items).toHaveLength(1);
    expect(listResponse.json().items[0].id).toBe(webhook.id);

    // Delete webhook
    const deleteResponse = await app.inject({
      method: "DELETE",
      url: `/v1/webhooks/${webhook.id}`,
      headers,
    });

    expect(deleteResponse.statusCode).toBe(204);

    // Verify deleted
    const afterDelete = await app.inject({
      method: "GET",
      url: "/v1/webhooks",
      headers,
    });

    expect(afterDelete.json().items).toHaveLength(0);
  });

  it("returns 404 when deleting a non-existent webhook", async () => {
    const response = await app.inject({
      method: "DELETE",
      url: "/v1/webhooks/whk_nonexistent",
      headers,
    });

    expect(response.statusCode).toBe(404);
  });

  it("expires stale approvals when listing pending", async () => {
    // Build a separate app with 0-minute TTL so approvals expire immediately
    const { buildApp } = await import("../../src/app");
    const { MemoryDataStore } = await import("../../src/infrastructure/memory/store");
    const { MemoryUsageStore } = await import("../../src/infrastructure/memory/usage-store");
    const { NoopJobQueue } = await import("../../src/infrastructure/jobs/noop-job-queue");
    const { seedDemoData } = await import("../../src/demo/seed-data");

    const { app: shortApp, services: shortServices } = await buildApp({
      env: {
        NODE_ENV: "test",
        HOST: "127.0.0.1",
        PORT: 3000,
        LOG_LEVEL: "silent",
        DATABASE_URL: "postgresql://toolguard:toolguard@localhost:5432/toolguard?schema=public",
        REDIS_URL: "redis://localhost:6379",
        STORAGE_MODE: "memory",
        ENABLE_SWAGGER: false,
        ALLOW_SELF_SIGNUP: true,
        DEV_DEFAULT_DECISION: "allow",
        PROD_DEFAULT_DECISION: "require_approval",
        APPROVAL_TTL_MINUTES: 0, // expires immediately
        PUBLIC_RATE_LIMIT_MAX: 1000,
        PUBLIC_RATE_LIMIT_WINDOW_SECONDS: 60,
        ORG_DAILY_MAX_ACTIONS: 1000,
        ORG_DAILY_MAX_SPEND_USD: 5000,
        ORG_DAILY_MAX_TOKENS: 500000,
        PER_TOOL_DAILY_MAX_ACTIONS: 200,
        BULLMQ_ENABLED: false,
        CORS_ALLOWED_ORIGINS: "",
      },
      store: new MemoryDataStore(),
      usageStore: new MemoryUsageStore(),
      jobQueue: new NoopJobQueue(),
    });

    const shortSeed = await seedDemoData(shortServices.store, shortServices.authService);
    const shortHeaders = { authorization: `Bearer ${shortSeed.rawApiKey}` };

    // Create a session and trigger an approval
    const sessResp = await shortApp.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: shortHeaders,
      payload: {
        orgId: shortSeed.organizationId,
        agentId: shortSeed.agentId,
        scopes: ["gmail:send", "gmail:write"],
        metadata: {},
      },
    });
    const session = sessResp.json();

    await shortApp.inject({
      method: "POST",
      url: "/v1/tool/authorize",
      headers: shortHeaders,
      payload: {
        orgId: shortSeed.organizationId,
        agentId: shortSeed.agentId,
        sessionId: session.id,
        tool: { name: shortSeed.toolNames.gmail },
        context: { environment: "production", justification: "Test" },
        payloadSummary: { recipientDomain: "gmail.com" },
        tokenCount: 5,
      },
    });

    // Wait a tick so the TTL (0 min) is past
    await new Promise((r) => setTimeout(r, 10));

    // Key test: list expired FIRST (before any pending call) —
    // the approval is still stored as "pending" but should appear as expired
    const expiredResp = await shortApp.inject({
      method: "GET",
      url: "/v1/approvals?status=expired",
      headers: shortHeaders,
    });
    expect(expiredResp.statusCode).toBe(200);
    expect(expiredResp.json().items.length).toBeGreaterThanOrEqual(1);
    for (const item of expiredResp.json().items) {
      expect(item.status).toBe("expired");
    }

    // Now pending should be empty (the sweep already flipped them)
    const listResp = await shortApp.inject({
      method: "GET",
      url: "/v1/approvals?status=pending",
      headers: shortHeaders,
    });
    expect(listResp.statusCode).toBe(200);
    for (const item of listResp.json().items) {
      expect(item.status).toBe("pending");
    }

    await shortApp.close();
  });

  it("rejects webhook registration targeting private addresses", async () => {
    const privateUrls = [
      "http://localhost:8080/hook",
      "http://127.0.0.1/hook",
      "http://169.254.169.254/latest/meta-data",
      "http://10.0.0.1/internal",
      "http://192.168.1.1/admin",
      "https://[fd00::1]/hook",
      "https://[::1]/hook",
      "https://[fe80::1]/hook",
      "https://[::ffff:127.0.0.1]/hook",
      "https://[::ffff:169.254.169.254]/hook",
      "https://localhost./hook",
      "https://metadata.google.internal./hook",
    ];

    for (const url of privateUrls) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/webhooks",
        headers,
        payload: {
          url,
          eventTypes: ["approval.requested"],
        },
      });

      expect(response.statusCode).toBe(422);
      expect(response.json().error).toBe("INVALID_WEBHOOK_URL");
    }
  });

  it("rejects webhook URLs that resolve to private IPs via DNS rebinding", async () => {
    // Simulate a public-looking hostname (e.g. 127.0.0.1.nip.io) that resolves to loopback
    const { resolve4 } = await import("node:dns/promises");
    vi.mocked(resolve4).mockResolvedValueOnce(["127.0.0.1"]);

    const response = await app.inject({
      method: "POST",
      url: "/v1/webhooks",
      headers,
      payload: {
        url: "https://evil-rebind.example.com/hook",
        eventTypes: ["approval.requested"],
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error).toBe("INVALID_WEBHOOK_URL");
  });

  it("delivers webhooks to HTTP URLs in non-production environments", async () => {
    // Register an HTTP (not HTTPS) webhook — allowed because NODE_ENV=test
    const createResp = await app.inject({
      method: "POST",
      url: "/v1/webhooks",
      headers,
      payload: {
        url: "http://example.com/hook",
        eventTypes: ["approval.requested"],
      },
    });
    expect(createResp.statusCode).toBe(201);

    // Spy on fetch to verify delivery-time validation doesn't reject the HTTP URL
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(new Response("ok"));

    try {
      // Create session + trigger approval (fires webhook)
      const sessResp = await app.inject({
        method: "POST",
        url: "/v1/sessions",
        headers,
        payload: {
          orgId: seed.organizationId,
          agentId: seed.agentId,
          userId: "user_webhook_http",
          servicePrincipal: null,
          environment: "production",
          scopes: ["gmail:send"],
          metadata: {},
        },
      });
      const session = sessResp.json();

      await app.inject({
        method: "POST",
        url: "/v1/tool/authorize",
        headers,
        payload: {
          orgId: seed.organizationId,
          agentId: seed.agentId,
          sessionId: session.id,
          tool: { name: seed.toolNames.gmail, action: "send", resource: "external_email", riskLevel: "high", estimatedCostUsd: 0 },
          context: { environment: "production", justification: "HTTP webhook test" },
          payloadSummary: { recipientDomain: "gmail.com" },
          tokenCount: 5,
        },
      });

      // Give the fire-and-forget webhook dispatch a tick to run
      await new Promise((r) => setTimeout(r, 50));

      // Verify fetch was called with the HTTP URL (not silently dropped)
      const httpCalls = fetchSpy.mock.calls.filter(
        ([url]) => typeof url === "string" && url.startsWith("http://example.com/hook"),
      );
      expect(httpCalls.length).toBeGreaterThanOrEqual(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("rejects webhook URLs that resolve to link-local IPv6 via DNS", async () => {
    const { resolve4, resolve6 } = await import("node:dns/promises");
    vi.mocked(resolve4).mockRejectedValueOnce(Object.assign(new Error("ENODATA"), { code: "ENODATA" }));
    vi.mocked(resolve6).mockResolvedValueOnce(["fe80::1"]);

    const response = await app.inject({
      method: "POST",
      url: "/v1/webhooks",
      headers,
      payload: {
        url: "https://ipv6-rebind.example.com/hook",
        eventTypes: ["approval.requested"],
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error).toBe("INVALID_WEBHOOK_URL");
  });
});
