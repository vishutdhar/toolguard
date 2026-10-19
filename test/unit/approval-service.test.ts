import { beforeEach, describe, expect, it } from "vitest";
import { ApprovalService } from "../../src/services/approval-service";
import { AuditService } from "../../src/services/audit-service";
import { MemoryDataStore } from "../../src/infrastructure/memory/store";
import { NoopJobQueue } from "../../src/infrastructure/jobs/noop-job-queue";

const BINDING = {
  toolName: "stripe.refund",
  action: "refund",
  resource: "stripe",
};

async function setup() {
  const store = new MemoryDataStore();
  let clock = new Date("2026-01-01T00:00:00.000Z");
  const svc = new ApprovalService(store, new AuditService(store), new NoopJobQueue(), 60, () => clock);

  const org = await store.createOrganization({ name: "o" });
  const agent = await store.createAgent({ organizationId: org.id, name: "a", environment: "production", defaultScopes: [] });
  const session = await store.createSession({ organizationId: org.id, agentId: agent.id, environment: "production", scopes: [], metadata: {} });

  const approval = await svc.create({
    organizationId: org.id,
    sessionId: session.id,
    reasonCodes: ["NEEDS_APPROVAL"],
    requestedByAgentId: agent.id,
    ...BINDING,
  });

  const binding = { approvalId: approval.id, organizationId: org.id, sessionId: session.id, ...BINDING };
  return { store, svc, approval, binding, setClock: (d: string) => { clock = new Date(d); } };
}

describe("approval-service expiry enforcement (M3)", () => {
  it("rejects consuming an approved approval after it has expired", async () => {
    const { svc, approval, binding, setClock } = await setup();
    await svc.resolve(approval.id, "approved", "human:reviewer");

    // TTL is 60 minutes; jump 2 hours past creation
    setClock("2026-01-01T02:00:00.000Z");

    await expect(svc.validateApprovedApproval(binding)).rejects.toMatchObject({ code: "APPROVAL_EXPIRED" });
  });

  it("still validates an approved approval before expiry", async () => {
    const { svc, approval, binding, setClock } = await setup();
    await svc.resolve(approval.id, "approved", "human:reviewer");
    setClock("2026-01-01T00:30:00.000Z"); // within the 60m window

    const validated = await svc.validateApprovedApproval(binding);
    expect(validated.status).toBe("approved");
  });
});

describe("approval-service idempotent consume (L1)", () => {
  beforeEach(() => {});

  it("returns idempotently when the same invocation consumes twice", async () => {
    const { svc, approval } = await setup();
    await svc.resolve(approval.id, "approved", "human:reviewer");

    const first = await svc.consume(approval.id, "inv-1");
    expect(first.status).toBe("consumed");

    const second = await svc.consume(approval.id, "inv-1");
    expect(second.status).toBe("consumed");
    expect(second.consumedByInvocationId).toBe("inv-1");
  });

  it("rejects consumption by a different invocation after it is consumed", async () => {
    const { svc, approval } = await setup();
    await svc.resolve(approval.id, "approved", "human:reviewer");
    await svc.consume(approval.id, "inv-1");

    await expect(svc.consume(approval.id, "inv-2")).rejects.toMatchObject({ code: "APPROVAL_STATUS_CHANGED" });
  });
});
