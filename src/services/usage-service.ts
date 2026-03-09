import type { DataStore } from "../domain/store";
import type { UsageReservationLimits, UsageSnapshot, UsageStore } from "../domain/usage-store";

export interface UsageLimitsConfig {
  orgDailyMaxActions: number;
  orgDailyMaxSpendUsd: number;
  orgDailyMaxTokens: number;
  perToolDailyMaxActions: number;
}

export interface LimitsSnapshot {
  remainingActionsToday: number;
  remainingBudgetUsd: number;
  remainingToolActionsToday: number;
  remainingTokensToday: number;
}

export interface UsageCheckInput {
  organizationId: string;
  toolName: string;
  estimatedCostUsd?: number;
  tokenCount?: number;
  reserve?: boolean;
}

export interface UsageCheckResult {
  allowed: boolean;
  reasonCodes: string[];
  limits: LimitsSnapshot;
  windowKey: string;
}

export class UsageService {
  constructor(
    private readonly store: DataStore,
    private readonly usageStore: UsageStore,
    private readonly config: UsageLimitsConfig,
    private readonly now: () => Date = () => new Date(),
  ) {}

  getWindowKey(date: Date): string {
    return date.toISOString().slice(0, 10);
  }

  async checkUsage(input: UsageCheckInput): Promise<UsageCheckResult> {
    const estimatedCostUsd = input.estimatedCostUsd ?? 0;
    const tokenCount = input.tokenCount ?? 0;
    const reserve = input.reserve ?? false;
    const windowKey = this.getWindowKey(this.now());
    const limits = this.getReservationLimits();

    if (reserve) {
      const reservation = await this.usageStore.reserveIfAllowed({
        organizationId: input.organizationId,
        toolName: input.toolName,
        windowKey,
        estimatedCostUsd,
        tokenCount,
        limits,
      });

      if (reservation.allowed) {
        await this.persistCounters(input.organizationId, input.toolName, windowKey, reservation.snapshot);
      }

      return {
        allowed: reservation.allowed,
        reasonCodes: reservation.allowed ? [] : this.getReasonCodes(reservation.snapshot, limits),
        windowKey,
        limits: this.toLimits(reservation.snapshot),
      };
    }

    const current = await this.usageStore.getSnapshot({
      organizationId: input.organizationId,
      toolName: input.toolName,
      windowKey,
    });
    const projected = this.projectSnapshot(current, estimatedCostUsd, tokenCount);
    const reasonCodes = this.getReasonCodes(projected, limits);
    const allowed = reasonCodes.length === 0;

    return {
      allowed,
      reasonCodes,
      windowKey,
      limits: this.toLimits(projected),
    };
  }

  private getReservationLimits(): UsageReservationLimits {
    return {
      orgDailyMaxActions: this.config.orgDailyMaxActions,
      orgDailyMaxSpendUsd: this.config.orgDailyMaxSpendUsd,
      orgDailyMaxTokens: this.config.orgDailyMaxTokens,
      perToolDailyMaxActions: this.config.perToolDailyMaxActions,
    };
  }

  private getReasonCodes(snapshot: UsageSnapshot, limits: UsageReservationLimits): string[] {
    const reasonCodes: string[] = [];
    if (snapshot.orgRequestCount > limits.orgDailyMaxActions) {
      reasonCodes.push("ORG_DAILY_ACTION_LIMIT_EXCEEDED");
    }
    if (snapshot.orgSpendUsd > limits.orgDailyMaxSpendUsd) {
      reasonCodes.push("ORG_DAILY_SPEND_LIMIT_EXCEEDED");
    }
    if (snapshot.orgTokenCount > limits.orgDailyMaxTokens) {
      reasonCodes.push("ORG_DAILY_TOKEN_LIMIT_EXCEEDED");
    }
    if (snapshot.toolRequestCount > limits.perToolDailyMaxActions) {
      reasonCodes.push("TOOL_DAILY_ACTION_LIMIT_EXCEEDED");
    }

    return reasonCodes;
  }

  private projectSnapshot(current: UsageSnapshot, estimatedCostUsd: number, tokenCount: number): UsageSnapshot {
    return {
      windowKey: current.windowKey,
      orgRequestCount: current.orgRequestCount + 1,
      orgSpendUsd: Number((current.orgSpendUsd + estimatedCostUsd).toFixed(2)),
      orgTokenCount: current.orgTokenCount + tokenCount,
      toolRequestCount: current.toolRequestCount + 1,
      toolSpendUsd: Number((current.toolSpendUsd + estimatedCostUsd).toFixed(2)),
      toolTokenCount: current.toolTokenCount + tokenCount,
    };
  }

  private async persistCounters(
    organizationId: string,
    toolName: string,
    windowKey: string,
    snapshot: UsageSnapshot,
  ): Promise<void> {
    await Promise.all([
      this.store.upsertUsageCounter({
        organizationId,
        windowKey,
        scopeKey: `org:${organizationId}:${windowKey}`,
        requestCount: snapshot.orgRequestCount,
        spendUsd: snapshot.orgSpendUsd,
        tokenCount: snapshot.orgTokenCount,
      }),
      this.store.upsertUsageCounter({
        organizationId,
        toolName,
        windowKey,
        scopeKey: `tool:${organizationId}:${toolName}:${windowKey}`,
        requestCount: snapshot.toolRequestCount,
        spendUsd: snapshot.toolSpendUsd,
        tokenCount: snapshot.toolTokenCount,
      }),
    ]);
  }

  private toLimits(snapshot: UsageSnapshot): LimitsSnapshot {
    return {
      remainingActionsToday: Math.max(this.config.orgDailyMaxActions - snapshot.orgRequestCount, 0),
      remainingBudgetUsd: Math.max(Number((this.config.orgDailyMaxSpendUsd - snapshot.orgSpendUsd).toFixed(2)), 0),
      remainingToolActionsToday: Math.max(this.config.perToolDailyMaxActions - snapshot.toolRequestCount, 0),
      remainingTokensToday: Math.max(this.config.orgDailyMaxTokens - snapshot.orgTokenCount, 0),
    };
  }
}
