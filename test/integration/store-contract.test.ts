/**
 * Store contract tests — verify that both MemoryDataStore and PrismaDataStore
 * implement the DataStore interface identically for critical behaviors.
 *
 * Memory tests always run. Prisma tests run when TEST_DATABASE_URL is set
 * (e.g., in CI or local dev with Docker Postgres).
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { MemoryDataStore } from "../../src/infrastructure/memory/store";
import { AppError } from "../../src/lib/errors";
import type { DataStore } from "../../src/domain/store";

// --- Helpers to create prerequisite records ---

async function seedPrerequisites(store: DataStore) {
  const org = await store.createOrganization({ name: "contract-test-org" });
  const agent = await store.createAgent({
    organizationId: org.id,
    name: "contract-agent",
    environment: "production",
    defaultScopes: [],
  });
  const session = await store.createSession({
    organizationId: org.id,
    agentId: agent.id,
    environment: "production",
    scopes: [],
    metadata: {},
  });
  return { org, agent, session };
}

// --- Contract test suite ---

function storeContractSuite(name: string, createStore: () => DataStore | Promise<DataStore>) {
  describe(`DataStore contract: ${name}`, () => {
    let store: DataStore;

    beforeEach(async () => {
      store = await createStore();
    });

    // -- Approval CAS --

    it("updateApprovalRequest with matching expectedStatus succeeds", async () => {
      const { org, agent, session } = await seedPrerequisites(store);

      const approval = await store.createApprovalRequest({
        organizationId: org.id,
        sessionId: session.id,
        status: "pending",
        reasonCodes: ["TEST"],
        toolName: "test.tool",
        action: "test",
        resource: "test",
        requestedByAgentId: agent.id,
        expiresAt: new Date(Date.now() + 600_000),
      });

      const updated = await store.updateApprovalRequest(
        approval.id,
        { status: "approved", resolvedBy: "tester", resolvedAt: new Date() },
        "pending",
      );

      expect(updated.status).toBe("approved");
      expect(updated.resolvedBy).toBe("tester");
    });

    it("updateApprovalRequest with wrong expectedStatus throws AppError 409", async () => {
      const { org, agent, session } = await seedPrerequisites(store);

      const approval = await store.createApprovalRequest({
        organizationId: org.id,
        sessionId: session.id,
        status: "pending",
        reasonCodes: ["TEST"],
        toolName: "test.tool",
        action: "test",
        resource: "test",
        requestedByAgentId: agent.id,
        expiresAt: new Date(Date.now() + 600_000),
      });

      // First resolve succeeds
      await store.updateApprovalRequest(
        approval.id,
        { status: "approved", resolvedBy: "winner", resolvedAt: new Date() },
        "pending",
      );

      // Second resolve with expectedStatus="pending" must fail with 409
      try {
        await store.updateApprovalRequest(
          approval.id,
          { status: "rejected", resolvedBy: "loser", resolvedAt: new Date() },
          "pending",
        );
        expect.fail("Expected AppError to be thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).statusCode).toBe(409);
        expect((error as AppError).code).toBe("APPROVAL_STATUS_CHANGED");
      }

      // Verify the first write won — status should be "approved"
      const final = await store.getApprovalRequest(approval.id);
      expect(final?.status).toBe("approved");
      expect(final?.resolvedBy).toBe("winner");
    });

    it("updateApprovalRequest without expectedStatus always succeeds", async () => {
      const { org, agent, session } = await seedPrerequisites(store);

      const approval = await store.createApprovalRequest({
        organizationId: org.id,
        sessionId: session.id,
        status: "pending",
        reasonCodes: ["TEST"],
        toolName: "test.tool",
        action: "test",
        resource: "test",
        requestedByAgentId: agent.id,
        expiresAt: new Date(Date.now() + 600_000),
      });

      // Resolve without CAS
      await store.updateApprovalRequest(
        approval.id,
        { status: "approved", resolvedBy: "first", resolvedAt: new Date() },
      );

      // Overwrite without CAS — should succeed (no guard)
      const overwritten = await store.updateApprovalRequest(
        approval.id,
        { status: "rejected", resolvedBy: "second", resolvedAt: new Date() },
      );

      expect(overwritten.status).toBe("rejected");
      expect(overwritten.resolvedBy).toBe("second");
    });

    // -- Tool estimatedCostUsd --

    it("createTool persists estimatedCostUsd and returns it", async () => {
      const { org } = await seedPrerequisites(store);

      const tool = await store.createTool({
        organizationId: org.id,
        name: "cost.test",
        action: "charge",
        resource: "payment",
        riskLevel: "high",
        estimatedCostUsd: 12.75,
      });

      expect(tool.estimatedCostUsd).toBe(12.75);

      const found = await store.findToolByName(org.id, "cost.test");
      expect(found?.estimatedCostUsd).toBe(12.75);
    });

    it("createTool defaults estimatedCostUsd to 0 when omitted", async () => {
      const { org } = await seedPrerequisites(store);

      const tool = await store.createTool({
        organizationId: org.id,
        name: "cost.default",
        action: "read",
        resource: "data",
        riskLevel: "low",
      });

      expect(tool.estimatedCostUsd).toBe(0);
    });
  });
}

// --- Memory store: always runs ---

storeContractSuite("MemoryDataStore", () => new MemoryDataStore());

// --- Prisma store: runs when TEST_DATABASE_URL is set ---

const testDbUrl = process.env.TEST_DATABASE_URL;

if (testDbUrl) {
  // Dynamic import to avoid loading @prisma/client when not needed
  const { PrismaClient } = await import("@prisma/client");
  const { PrismaDataStore } = await import("../../src/infrastructure/prisma/store");
  const { execSync } = await import("child_process");

  const prismaClient = new PrismaClient({ datasources: { db: { url: testDbUrl } } });

  // Run migrations against the test database
  execSync("npx prisma migrate deploy", {
    env: { ...process.env, DATABASE_URL: testDbUrl },
    stdio: "pipe",
  });

  storeContractSuite("PrismaDataStore", async () => {
    // Clean tables before each test (reverse FK order)
    await prismaClient.$executeRawUnsafe("DELETE FROM \"AuditEvent\"");
    await prismaClient.$executeRawUnsafe("DELETE FROM \"ApprovalRequest\"");
    await prismaClient.$executeRawUnsafe("DELETE FROM \"Run\"");
    await prismaClient.$executeRawUnsafe("DELETE FROM \"UsageCounter\"");
    await prismaClient.$executeRawUnsafe("DELETE FROM \"Session\"");
    await prismaClient.$executeRawUnsafe("DELETE FROM \"PolicyVersion\"");
    await prismaClient.$executeRawUnsafe("DELETE FROM \"Policy\"");
    await prismaClient.$executeRawUnsafe("DELETE FROM \"Tool\"");
    await prismaClient.$executeRawUnsafe("DELETE FROM \"Agent\"");
    await prismaClient.$executeRawUnsafe("DELETE FROM \"ApiKey\"");
    await prismaClient.$executeRawUnsafe("DELETE FROM \"Organization\"");
    return new PrismaDataStore(prismaClient);
  });

  afterAll(async () => {
    await prismaClient.$disconnect();
  });
}
