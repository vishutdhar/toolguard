import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTestApp } from "../helpers/build-test-app";

// H2: approvals must be resolvable only by keys that carry the approvals:resolve
// capability, so an agent-runtime key can be denied the ability to approve the
// very actions it requests (enforceable separation of duties).
describe("API key capability enforcement (H2)", () => {
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

  async function createSession() {
    const res = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers,
      payload: {
        orgId: seed.organizationId,
        agentId: seed.agentId,
        environment: "production",
        scopes: ["stripe:refund"],
        metadata: {},
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json();
  }

  async function createApproval(sessionId: string) {
    const res = await app.inject({
      method: "POST",
      url: "/v1/approvals/request",
      headers,
      payload: {
        orgId: seed.organizationId,
        sessionId,
        reasonCodes: ["HIGH_RISK"],
        toolName: "stripe.refund",
        action: "refund",
        resource: "stripe",
        requestedByAgentId: seed.agentId,
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json();
  }

  async function mintScopedKey(scopes: string[]) {
    const res = await app.inject({
      method: "POST",
      url: "/v1/api-keys",
      headers,
      payload: { orgId: seed.organizationId, name: "agent-runtime", scopes },
    });
    expect(res.statusCode).toBe(201);
    return res.json().rawApiKey as string;
  }

  it("rejects approval resolution by a key lacking approvals:resolve", async () => {
    const session = await createSession();
    const approval = await createApproval(session.id);
    const agentKey = await mintScopedKey(["tool:authorize"]);

    const denied = await app.inject({
      method: "POST",
      url: `/v1/approvals/${approval.id}/resolve`,
      headers: { authorization: `Bearer ${agentKey}` },
      payload: { status: "approved" },
    });
    expect(denied.statusCode).toBe(403);
  });

  it("allows a full-access key to resolve approvals", async () => {
    const session = await createSession();
    const approval = await createApproval(session.id);

    const ok = await app.inject({
      method: "POST",
      url: `/v1/approvals/${approval.id}/resolve`,
      headers,
      payload: { status: "approved" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().status).toBe("approved");
  });

  it("allows an explicitly-scoped approver key to resolve", async () => {
    const session = await createSession();
    const approval = await createApproval(session.id);
    const approverKey = await mintScopedKey(["approvals:resolve"]);

    const ok = await app.inject({
      method: "POST",
      url: `/v1/approvals/${approval.id}/resolve`,
      headers: { authorization: `Bearer ${approverKey}` },
      payload: { status: "approved" },
    });
    expect(ok.statusCode).toBe(200);
  });
});

// P1 (PR #1 review): POST /v1/api-keys used to check only org membership and
// default new keys to ["*"], so a restricted key could mint a full-access key
// and then resolve approvals. Key creation now needs api_keys:create, and new
// scopes must be a subset of the caller's scopes.
describe("API key minting cannot escalate privileges", () => {
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

  async function mint(authHeaders: Record<string, string>, scopes?: string[]) {
    return app.inject({
      method: "POST",
      url: "/v1/api-keys",
      headers: authHeaders,
      payload: { orgId: seed.organizationId, name: "minted", ...(scopes ? { scopes } : {}) },
    });
  }

  async function mintAsAdmin(scopes: string[]) {
    const res = await mint(headers, scopes);
    expect(res.statusCode).toBe(201);
    return { authorization: `Bearer ${res.json().rawApiKey as string}` };
  }

  it("refuses key creation by a key without api_keys:create", async () => {
    const agentHeaders = await mintAsAdmin(["tool:authorize"]);

    for (const scopes of [["*"], ["approvals:resolve"], ["tool:authorize"], undefined]) {
      const res = await mint(agentHeaders, scopes);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: "CAPABILITY_REQUIRED" });
      expect(typeof res.json().message).toBe("string");
    }
  });

  it("refuses a limited key minting * or approvals:resolve even with api_keys:create", async () => {
    const managerHeaders = await mintAsAdmin(["api_keys:create", "tool:authorize"]);

    const wildcard = await mint(managerHeaders, ["*"]);
    expect(wildcard.statusCode).toBe(403);
    expect(wildcard.json()).toMatchObject({
      error: "SCOPE_ESCALATION",
      details: { notHeld: ["*"] },
    });

    const approver = await mint(managerHeaders, ["tool:authorize", "approvals:resolve"]);
    expect(approver.statusCode).toBe(403);
    expect(approver.json()).toMatchObject({
      error: "SCOPE_ESCALATION",
      details: { notHeld: ["approvals:resolve"] },
    });
  });

  it("lets a limited key mint a key with the same or narrower scopes", async () => {
    const managerHeaders = await mintAsAdmin(["api_keys:create", "tool:authorize"]);

    const narrower = await mint(managerHeaders, ["tool:authorize"]);
    expect(narrower.statusCode).toBe(201);
    // The narrower key lacks api_keys:create, so it cannot mint further keys.
    const narrowerHeaders = { authorization: `Bearer ${narrower.json().rawApiKey as string}` };
    expect((await mint(narrowerHeaders, ["tool:authorize"])).statusCode).toBe(403);

    // Omitted scopes inherit the caller's scopes instead of defaulting to "*":
    // the inherited key can mint tool:authorize but still not "*".
    const inherited = await mint(managerHeaders);
    expect(inherited.statusCode).toBe(201);
    const inheritedHeaders = { authorization: `Bearer ${inherited.json().rawApiKey as string}` };
    expect((await mint(inheritedHeaders, ["tool:authorize"])).statusCode).toBe(201);
    const escalate = await mint(inheritedHeaders, ["*"]);
    expect(escalate.statusCode).toBe(403);
    expect(escalate.json()).toMatchObject({ error: "SCOPE_ESCALATION" });
  });

  it("refuses an empty scope list, which the store would treat as full access", async () => {
    const managerHeaders = await mintAsAdmin(["api_keys:create", "tool:authorize"]);
    const res = await mint(managerHeaders, []);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "INVALID_SCOPES" });
  });

  it("a key minted by a limited key still cannot resolve approvals", async () => {
    const managerHeaders = await mintAsAdmin(["api_keys:create", "tool:authorize"]);
    const child = await mint(managerHeaders);
    expect(child.statusCode).toBe(201);
    const childHeaders = { authorization: `Bearer ${child.json().rawApiKey as string}` };

    const session = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers,
      payload: {
        orgId: seed.organizationId,
        agentId: seed.agentId,
        environment: "production",
        scopes: ["stripe:refund"],
        metadata: {},
      },
    });
    const approval = await app.inject({
      method: "POST",
      url: "/v1/approvals/request",
      headers,
      payload: {
        orgId: seed.organizationId,
        sessionId: session.json().id,
        reasonCodes: ["HIGH_RISK"],
        toolName: "stripe.refund",
        action: "refund",
        resource: "stripe",
        requestedByAgentId: seed.agentId,
      },
    });
    expect(approval.statusCode).toBe(201);

    const denied = await app.inject({
      method: "POST",
      url: `/v1/approvals/${approval.json().id}/resolve`,
      headers: childHeaders,
      payload: { status: "approved" },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ error: "CAPABILITY_REQUIRED" });
  });

  it("full-access keys can still mint any key, and omitted scopes stay full access", async () => {
    const full = await mint(headers);
    expect(full.statusCode).toBe(201);
    const fullHeaders = { authorization: `Bearer ${full.json().rawApiKey as string}` };
    expect((await mint(fullHeaders, ["*"])).statusCode).toBe(201);

    const approver = await mint(headers, ["approvals:resolve"]);
    expect(approver.statusCode).toBe(201);
  });

  it("self-signup still returns a working full-access key", async () => {
    const signup = await app.inject({
      method: "POST",
      url: "/v1/organizations",
      payload: { name: "Fresh Org" },
    });
    expect(signup.statusCode).toBe(201);
    const body = signup.json();

    const res = await app.inject({
      method: "POST",
      url: "/v1/api-keys",
      headers: { authorization: `Bearer ${body.rawApiKey as string}` },
      payload: { orgId: body.organization.id, name: "second", scopes: ["*"] },
    });
    expect(res.statusCode).toBe(201);
  });
});
