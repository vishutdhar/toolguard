import type {
  UsageReservationResult,
  UsageSnapshot,
  UsageStore,
  UsageStoreInput,
} from "../../domain/usage-store";

type CounterState = {
  requestCount: number;
  spendUsd: number;
  tokenCount: number;
};

export class MemoryUsageStore implements UsageStore {
  private readonly counters = new Map<string, CounterState>();

  async getSnapshot(input: Omit<UsageStoreInput, "estimatedCostUsd" | "tokenCount">): Promise<UsageSnapshot> {
    const orgCounter = this.counters.get(this.getOrgKey(input.organizationId, input.windowKey)) ?? {
      requestCount: 0,
      spendUsd: 0,
      tokenCount: 0,
    };
    const toolCounter = this.counters.get(this.getToolKey(input.organizationId, input.toolName, input.windowKey)) ?? {
      requestCount: 0,
      spendUsd: 0,
      tokenCount: 0,
    };

    return {
      windowKey: input.windowKey,
      orgRequestCount: orgCounter.requestCount,
      orgSpendUsd: orgCounter.spendUsd,
      orgTokenCount: orgCounter.tokenCount,
      toolRequestCount: toolCounter.requestCount,
      toolSpendUsd: toolCounter.spendUsd,
      toolTokenCount: toolCounter.tokenCount,
    };
  }

  async reserveIfAllowed(
    input: UsageStoreInput & {
      limits: {
        orgDailyMaxActions: number;
        orgDailyMaxSpendUsd: number;
        orgDailyMaxTokens: number;
        perToolDailyMaxActions: number;
      };
    },
  ): Promise<UsageReservationResult> {
    const orgKey = this.getOrgKey(input.organizationId, input.windowKey);
    const toolKey = this.getToolKey(input.organizationId, input.toolName, input.windowKey);
    const orgCounter = this.counters.get(orgKey) ?? { requestCount: 0, spendUsd: 0, tokenCount: 0 };
    const toolCounter = this.counters.get(toolKey) ?? { requestCount: 0, spendUsd: 0, tokenCount: 0 };

    const nextOrgCounter = {
      requestCount: orgCounter.requestCount + 1,
      spendUsd: orgCounter.spendUsd + input.estimatedCostUsd,
      tokenCount: orgCounter.tokenCount + input.tokenCount,
    };
    const nextToolCounter = {
      requestCount: toolCounter.requestCount + 1,
      spendUsd: toolCounter.spendUsd + input.estimatedCostUsd,
      tokenCount: toolCounter.tokenCount + input.tokenCount,
    };

    const projectedSnapshot: UsageSnapshot = {
      windowKey: input.windowKey,
      orgRequestCount: nextOrgCounter.requestCount,
      orgSpendUsd: nextOrgCounter.spendUsd,
      orgTokenCount: nextOrgCounter.tokenCount,
      toolRequestCount: nextToolCounter.requestCount,
      toolSpendUsd: nextToolCounter.spendUsd,
      toolTokenCount: nextToolCounter.tokenCount,
    };

    const withinLimits =
      projectedSnapshot.orgRequestCount <= input.limits.orgDailyMaxActions &&
      projectedSnapshot.orgSpendUsd <= input.limits.orgDailyMaxSpendUsd &&
      projectedSnapshot.orgTokenCount <= input.limits.orgDailyMaxTokens &&
      projectedSnapshot.toolRequestCount <= input.limits.perToolDailyMaxActions;

    if (!withinLimits) {
      return {
        allowed: false,
        snapshot: projectedSnapshot,
      };
    }

    this.counters.set(orgKey, nextOrgCounter);
    this.counters.set(toolKey, nextToolCounter);

    return {
      allowed: true,
      snapshot: projectedSnapshot,
    };
  }

  private getOrgKey(organizationId: string, windowKey: string): string {
    return `usage:org:${organizationId}:${windowKey}`;
  }

  private getToolKey(organizationId: string, toolName: string, windowKey: string): string {
    return `usage:tool:${organizationId}:${toolName}:${windowKey}`;
  }
}
