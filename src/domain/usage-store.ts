export interface UsageSnapshot {
  windowKey: string;
  orgRequestCount: number;
  orgSpendUsd: number;
  orgTokenCount: number;
  toolRequestCount: number;
  toolSpendUsd: number;
  toolTokenCount: number;
}

export interface UsageStoreInput {
  organizationId: string;
  toolName: string;
  windowKey: string;
  estimatedCostUsd: number;
  tokenCount: number;
}

export interface UsageReservationLimits {
  orgDailyMaxActions: number;
  orgDailyMaxSpendUsd: number;
  orgDailyMaxTokens: number;
  perToolDailyMaxActions: number;
}

export interface UsageReservationResult {
  allowed: boolean;
  snapshot: UsageSnapshot;
}

export interface UsageStore {
  getSnapshot(input: Omit<UsageStoreInput, "estimatedCostUsd" | "tokenCount">): Promise<UsageSnapshot>;
  reserveIfAllowed(input: UsageStoreInput & { limits: UsageReservationLimits }): Promise<UsageReservationResult>;
}
