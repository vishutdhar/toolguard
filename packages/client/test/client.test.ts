import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { ToolGuard } from "../src/client.js";
import { ToolGuardError } from "../src/errors.js";
import http from "node:http";

// Minimal HTTP server that mimics ToolGuard API responses
let server: http.Server;
let baseUrl: string;
let lastRequest: { method: string; url: string; headers: Record<string, string>; body: unknown } | null;

function respondWith(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const rawBody = Buffer.concat(chunks).toString();

    lastRequest = {
      method: req.method ?? "",
      url: req.url ?? "",
      headers: req.headers as Record<string, string>,
      body: rawBody ? JSON.parse(rawBody) : null,
    };

    // Route responses
    if (req.url === "/healthz") {
      return respondWith(res, 200, {
        status: "ok",
        service: "toolguard-api",
        storageMode: "memory",
        dependencies: { database: "skipped", redis: "skipped" },
      });
    }

    if (req.url === "/v1/organizations" && req.method === "POST") {
      return respondWith(res, 201, {
        organization: { id: "org_1", name: "Test" },
        apiKey: { id: "key_1", keyPrefix: "tg_abc" },
        rawApiKey: "tg_abc123",
      });
    }

    if (req.url === "/v1/tool/authorize" && req.method === "POST") {
      const body = JSON.parse(rawBody);
      const decision = body.tool.name === "allowed.tool" ? "allow" : "deny";
      return respondWith(res, 200, {
        decision,
        reasonCodes: decision === "deny" ? ["POLICY_DENIED"] : [],
        policyVersionId: "pv_1",
        matchedRuleIndex: 0,
        approvalId: null,
        approvalStatus: null,
        limits: {
          remainingActionsToday: 100,
          remainingBudgetUsd: 50,
          remainingToolActionsToday: 100,
          remainingTokensToday: 10000,
        },
      });
    }

    // Require auth for all other routes
    if (!req.headers.authorization?.startsWith("Bearer ")) {
      return respondWith(res, 401, { error: "UNAUTHORIZED", message: "Missing auth" });
    }

    if (req.url === "/v1/agents" && req.method === "GET") {
      return respondWith(res, 200, { items: [{ id: "agent_1", name: "test-agent" }] });
    }

    respondWith(res, 404, { error: "NOT_FOUND", message: "Route not found" });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const addr = server.address();
  if (typeof addr === "object" && addr) {
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  lastRequest = null;
});

describe("ToolGuard client", () => {
  it("health() works without API key", async () => {
    const tg = new ToolGuard({ baseUrl });
    const result = await tg.health();
    expect(result.status).toBe("ok");
    expect(lastRequest?.headers.authorization).toBeUndefined();
  });

  it("bootstrap() works without API key", async () => {
    const tg = new ToolGuard({ baseUrl });
    const result = await tg.bootstrap("Test Org");
    expect(result.organization.id).toBe("org_1");
    expect(result.rawApiKey).toBe("tg_abc123");
    expect(lastRequest?.headers.authorization).toBeUndefined();
  });

  it("sends Authorization header when apiKey is provided", async () => {
    const tg = new ToolGuard({ apiKey: "tg_secret", baseUrl });
    await tg.health();
    expect(lastRequest?.headers.authorization).toBe("Bearer tg_secret");
  });

  it("authorize() sets .allowed = true for allow decision", async () => {
    const tg = new ToolGuard({ apiKey: "tg_x", baseUrl, orgId: "org_1", agentId: "agent_1" });
    const result = await tg.authorize({
      sessionId: "sess_1",
      tool: { name: "allowed.tool" },
    });
    expect(result.decision).toBe("allow");
    expect(result.allowed).toBe(true);
    expect(result.denied).toBe(false);
    expect(result.pendingApproval).toBe(false);
  });

  it("authorize() sets .denied = true for deny decision", async () => {
    const tg = new ToolGuard({ apiKey: "tg_x", baseUrl, orgId: "org_1", agentId: "agent_1" });
    const result = await tg.authorize({
      sessionId: "sess_1",
      tool: { name: "denied.tool" },
    });
    expect(result.decision).toBe("deny");
    expect(result.denied).toBe(true);
    expect(result.allowed).toBe(false);
    expect(result.reasonCodes).toContain("POLICY_DENIED");
  });

  it("throws ToolGuardError on 401", async () => {
    const tg = new ToolGuard({ baseUrl }); // no API key
    await expect(tg.listAgents()).rejects.toThrow(ToolGuardError);
    try {
      await tg.listAgents();
    } catch (err) {
      const e = err as ToolGuardError;
      expect(e.statusCode).toBe(401);
      expect(e.code).toBe("UNAUTHORIZED");
    }
  });

  it("throws ToolGuardError with INVALID_RESPONSE for non-JSON", async () => {
    // Create a server that returns HTML
    const htmlServer = http.createServer((_req, res) => {
      res.writeHead(502, { "content-type": "text/html" });
      res.end("<html>Bad Gateway</html>");
    });
    await new Promise<void>((resolve) => htmlServer.listen(0, "127.0.0.1", () => resolve()));
    const addr = htmlServer.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    const tg = new ToolGuard({ baseUrl: `http://127.0.0.1:${port}` });
    await expect(tg.health()).rejects.toThrow(ToolGuardError);
    try {
      await tg.health();
    } catch (err) {
      const e = err as ToolGuardError;
      expect(e.code).toBe("INVALID_RESPONSE");
      expect(e.statusCode).toBe(502);
    }

    htmlServer.close();
  });

  it("throws when orgId is missing and not set in constructor", async () => {
    const tg = new ToolGuard({ apiKey: "tg_x", baseUrl });
    await expect(
      tg.authorize({ sessionId: "s", tool: { name: "x" } }),
    ).rejects.toThrow("orgId is required");
  });

  it("uses default orgId and agentId from constructor", async () => {
    const tg = new ToolGuard({ apiKey: "tg_x", baseUrl, orgId: "org_default", agentId: "agent_default" });
    await tg.authorize({ sessionId: "sess_1", tool: { name: "allowed.tool" } });
    expect(lastRequest?.body).toMatchObject({
      orgId: "org_default",
      agentId: "agent_default",
    });
  });

  it("explicit orgId overrides constructor default", async () => {
    const tg = new ToolGuard({ apiKey: "tg_x", baseUrl, orgId: "org_default", agentId: "agent_default" });
    await tg.authorize({ orgId: "org_override", sessionId: "sess_1", tool: { name: "allowed.tool" } });
    expect(lastRequest?.body).toMatchObject({ orgId: "org_override" });
  });
});
