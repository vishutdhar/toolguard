import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTestApp } from "../helpers/build-test-app";

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

    // First resolve succeeds
    const first = await app.inject({
      method: "POST",
      url: `/v1/approvals/${approvalId}/resolve`,
      headers,
      payload: { status: "approved" },
    });
    expect(first.statusCode).toBe(200);

    // Second resolve gets 409, NOT 500
    const second = await app.inject({
      method: "POST",
      url: `/v1/approvals/${approvalId}/resolve`,
      headers,
      payload: { status: "rejected" },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe("APPROVAL_STATUS_CHANGED");
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
});
