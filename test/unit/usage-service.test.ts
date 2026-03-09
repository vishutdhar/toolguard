import { describe, expect, it } from "vitest";
import { MemoryDataStore } from "../../src/infrastructure/memory/store";
import { MemoryUsageStore } from "../../src/infrastructure/memory/usage-store";
import { UsageService } from "../../src/services/usage-service";

describe("usage-service", () => {
  it("allows usage under limits and updates remaining capacity", async () => {
    const service = new UsageService(
      new MemoryDataStore(),
      new MemoryUsageStore(),
      {
        orgDailyMaxActions: 2,
        orgDailyMaxSpendUsd: 10,
        orgDailyMaxTokens: 100,
        perToolDailyMaxActions: 1,
      },
      () => new Date("2026-03-06T12:00:00.000Z"),
    );

    const result = await service.checkUsage({
      organizationId: "org_1",
      toolName: "slack.post_message",
      estimatedCostUsd: 2.5,
      tokenCount: 25,
      reserve: true,
    });

    expect(result.allowed).toBe(true);
    expect(result.limits.remainingActionsToday).toBe(1);
    expect(result.limits.remainingBudgetUsd).toBe(7.5);
    expect(result.limits.remainingToolActionsToday).toBe(0);
    expect(result.limits.remainingTokensToday).toBe(75);
  });

  it("denies when the org action limit would be exceeded", async () => {
    const service = new UsageService(
      new MemoryDataStore(),
      new MemoryUsageStore(),
      {
        orgDailyMaxActions: 1,
        orgDailyMaxSpendUsd: 10,
        orgDailyMaxTokens: 100,
        perToolDailyMaxActions: 10,
      },
      () => new Date("2026-03-06T12:00:00.000Z"),
    );

    await service.checkUsage({
      organizationId: "org_1",
      toolName: "slack.post_message",
      reserve: true,
    });

    const secondAttempt = await service.checkUsage({
      organizationId: "org_1",
      toolName: "slack.post_message",
      reserve: true,
    });

    expect(secondAttempt.allowed).toBe(false);
    expect(secondAttempt.reasonCodes).toContain("ORG_DAILY_ACTION_LIMIT_EXCEEDED");
  });

  it("evaluates projected usage without reserving it", async () => {
    const service = new UsageService(
      new MemoryDataStore(),
      new MemoryUsageStore(),
      {
        orgDailyMaxActions: 1,
        orgDailyMaxSpendUsd: 5,
        orgDailyMaxTokens: 50,
        perToolDailyMaxActions: 1,
      },
      () => new Date("2026-03-06T12:00:00.000Z"),
    );

    const preview = await service.checkUsage({
      organizationId: "org_1",
      toolName: "gmail.send_email",
      estimatedCostUsd: 1,
      tokenCount: 10,
      reserve: false,
    });

    expect(preview.allowed).toBe(true);
    expect(preview.limits.remainingActionsToday).toBe(0);
    expect(preview.limits.remainingBudgetUsd).toBe(4);
    expect(preview.limits.remainingTokensToday).toBe(40);

    const reserve = await service.checkUsage({
      organizationId: "org_1",
      toolName: "gmail.send_email",
      estimatedCostUsd: 1,
      tokenCount: 10,
      reserve: true,
    });

    expect(reserve.allowed).toBe(true);
    expect(reserve.limits.remainingActionsToday).toBe(0);
  });
});
