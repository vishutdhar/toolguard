import { buildApp } from "../src/app";
import { seedDemoData } from "../src/demo/seed-data";

async function main(): Promise<void> {
  const { app, services } = await buildApp({
    env: {
      ...process.env,
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
      APPROVAL_TTL_MINUTES: 60,
      PUBLIC_RATE_LIMIT_MAX: 1000,
      PUBLIC_RATE_LIMIT_WINDOW_SECONDS: 60,
      ORG_DAILY_MAX_ACTIONS: 1000,
      ORG_DAILY_MAX_SPEND_USD: 5000,
      ORG_DAILY_MAX_TOKENS: 500000,
      PER_TOOL_DAILY_MAX_ACTIONS: 200,
      BULLMQ_ENABLED: false,
    },
  });

  try {
    const seeded = await seedDemoData(services.store, services.authService);
    const headers = {
      authorization: `Bearer ${seeded.rawApiKey}`,
    };

    const sessionResponse = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers,
      payload: {
        orgId: seeded.organizationId,
        agentId: seeded.agentId,
        userId: "user_123",
        servicePrincipal: null,
        environment: "production",
        scopes: ["slack:write", "gmail:send", "stripe:refund"],
        metadata: {
          source: "support-bot",
        },
      },
    });
    const session = sessionResponse.json();

    const runResponse = await app.inject({
      method: "POST",
      url: "/v1/runs",
      headers,
      payload: {
        orgId: seeded.organizationId,
        sessionId: session.id,
        promptSummary: "Handle refund support workflow",
        metadata: {
          channel: "support",
        },
      },
    });
    const run = runResponse.json();

    const slackDecision = await app.inject({
      method: "POST",
      url: "/v1/tool/authorize",
      headers,
      payload: {
        orgId: seeded.organizationId,
        agentId: seeded.agentId,
        sessionId: session.id,
        runId: run.id,
        tool: {
          name: seeded.toolNames.slack,
          action: "post",
          resource: "internal_channel",
          riskLevel: "low",
          estimatedCostUsd: 0,
        },
        context: {
          environment: "production",
          justification: "Post internal case update",
        },
        payloadSummary: {
          channelType: "internal",
        },
        tokenCount: 25,
      },
    });

    const gmailDecision = await app.inject({
      method: "POST",
      url: "/v1/tool/authorize",
      headers,
      payload: {
        orgId: seeded.organizationId,
        agentId: seeded.agentId,
        sessionId: session.id,
        runId: run.id,
        tool: {
          name: seeded.toolNames.gmail,
          action: "send",
          resource: "external_email",
          riskLevel: "high",
          estimatedCostUsd: 0,
        },
        context: {
          environment: "production",
          justification: "Send refund update to the customer",
          sensitivity: "customer_data",
        },
        payloadSummary: {
          recipientDomain: "gmail.com",
          containsAttachment: false,
        },
        tokenCount: 120,
      },
    });
    const gmailAuthorization = gmailDecision.json();

    const approvalResolution = await app.inject({
      method: "POST",
      url: `/v1/approvals/${gmailAuthorization.approvalId}/resolve`,
      headers,
      payload: {
        status: "approved",
      },
    });

    const gmailApprovedDecision = await app.inject({
      method: "POST",
      url: "/v1/tool/authorize",
      headers,
      payload: {
        orgId: seeded.organizationId,
        agentId: seeded.agentId,
        sessionId: session.id,
        runId: run.id,
        approvalId: gmailAuthorization.approvalId,
        tool: {
          name: seeded.toolNames.gmail,
          action: "send",
          resource: "external_email",
          riskLevel: "high",
          estimatedCostUsd: 0,
        },
        context: {
          environment: "production",
          justification: "Send refund update to the customer",
          sensitivity: "customer_data",
        },
        payloadSummary: {
          recipientDomain: "gmail.com",
          containsAttachment: false,
        },
        tokenCount: 120,
      },
    });

    const stripeDecision = await app.inject({
      method: "POST",
      url: "/v1/tool/authorize",
      headers,
      payload: {
        orgId: seeded.organizationId,
        agentId: seeded.agentId,
        sessionId: session.id,
        runId: run.id,
        tool: {
          name: seeded.toolNames.stripeRefund,
          action: "refund",
          resource: "payment",
          riskLevel: "high",
          estimatedCostUsd: 0,
        },
        context: {
          environment: "production",
          justification: "Refund a large payment",
        },
        payloadSummary: {
          amountUsd: 1500,
        },
        tokenCount: 80,
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

    const replay = await app.inject({
      method: "GET",
      url: `/v1/runs/${run.id}/replay`,
      headers,
    });

    console.log("Support agent demo");
    console.log(JSON.stringify(
      {
        slackDecision: slackDecision.json(),
        gmailDecision: gmailAuthorization,
        approvalResolution: approvalResolution.json(),
        gmailApprovedDecision: gmailApprovedDecision.json(),
        stripeDecision: stripeDecision.json(),
        replay: replay.json(),
      },
      null,
      2,
    ));
  } finally {
    await app.close();
  }
}

void main();
