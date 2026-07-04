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
