import Redis from "ioredis";
import type {
  UsageReservationResult,
  UsageSnapshot,
  UsageStore,
  UsageStoreInput,
} from "../../domain/usage-store";

type CounterRecord = {
  requestCount: number;
  spendCents: number;
  tokenCount: number;
};

const reserveIfAllowedScript = `
local orgKey = KEYS[1]
local toolKey = KEYS[2]

local spendCents = tonumber(ARGV[1])
local tokenCount = tonumber(ARGV[2])
local ttlSeconds = tonumber(ARGV[3])
local orgDailyMaxActions = tonumber(ARGV[4])
local orgDailyMaxSpendCents = tonumber(ARGV[5])
local orgDailyMaxTokens = tonumber(ARGV[6])
local perToolDailyMaxActions = tonumber(ARGV[7])

local function getCounter(key, field)
  local value = redis.call("HGET", key, field)
  if not value then
    return 0
  end

  return tonumber(value)
end

local orgRequestCount = getCounter(orgKey, "requestCount")
local orgSpendCents = getCounter(orgKey, "spendCents")
local orgTokenCount = getCounter(orgKey, "tokenCount")
local toolRequestCount = getCounter(toolKey, "requestCount")
local toolSpendCents = getCounter(toolKey, "spendCents")
local toolTokenCount = getCounter(toolKey, "tokenCount")

local projectedOrgRequestCount = orgRequestCount + 1
local projectedOrgSpendCents = orgSpendCents + spendCents
local projectedOrgTokenCount = orgTokenCount + tokenCount
local projectedToolRequestCount = toolRequestCount + 1
local projectedToolSpendCents = toolSpendCents + spendCents
local projectedToolTokenCount = toolTokenCount + tokenCount

local allowed = 1
if projectedOrgRequestCount > orgDailyMaxActions then
  allowed = 0
end
if projectedOrgSpendCents > orgDailyMaxSpendCents then
  allowed = 0
end
if projectedOrgTokenCount > orgDailyMaxTokens then
  allowed = 0
end
if projectedToolRequestCount > perToolDailyMaxActions then
  allowed = 0
end

if allowed == 1 then
  redis.call("HINCRBY", orgKey, "requestCount", 1)
  redis.call("HINCRBY", orgKey, "spendCents", spendCents)
  redis.call("HINCRBY", orgKey, "tokenCount", tokenCount)
  redis.call("EXPIRE", orgKey, ttlSeconds)

  redis.call("HINCRBY", toolKey, "requestCount", 1)
  redis.call("HINCRBY", toolKey, "spendCents", spendCents)
  redis.call("HINCRBY", toolKey, "tokenCount", tokenCount)
  redis.call("EXPIRE", toolKey, ttlSeconds)
end

return {
  allowed,
  projectedOrgRequestCount,
  projectedOrgSpendCents,
  projectedOrgTokenCount,
  projectedToolRequestCount,
  projectedToolSpendCents,
  projectedToolTokenCount
}
`;

export class RedisUsageStore implements UsageStore {
  constructor(private readonly redis: Redis) {}

  async getSnapshot(input: Omit<UsageStoreInput, "estimatedCostUsd" | "tokenCount">): Promise<UsageSnapshot> {
    const orgKey = this.getOrgKey(input.organizationId, input.windowKey);
    const toolKey = this.getToolKey(input.organizationId, input.toolName, input.windowKey);
    const [orgState, toolState] = await Promise.all([this.readCounter(orgKey), this.readCounter(toolKey)]);

    return {
      windowKey: input.windowKey,
      orgRequestCount: orgState.requestCount,
      orgSpendUsd: orgState.spendCents / 100,
      orgTokenCount: orgState.tokenCount,
      toolRequestCount: toolState.requestCount,
      toolSpendUsd: toolState.spendCents / 100,
      toolTokenCount: toolState.tokenCount,
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
    const spendCents = Math.round(input.estimatedCostUsd * 100);
    const ttlSeconds = 60 * 60 * 48;
    const result = (await this.redis.eval(
      reserveIfAllowedScript,
      2,
      orgKey,
      toolKey,
      spendCents,
      input.tokenCount,
      ttlSeconds,
      input.limits.orgDailyMaxActions,
      Math.round(input.limits.orgDailyMaxSpendUsd * 100),
      input.limits.orgDailyMaxTokens,
      input.limits.perToolDailyMaxActions,
    )) as Array<number | string>;

    return {
      allowed: Number(result[0]) === 1,
      snapshot: {
        windowKey: input.windowKey,
        orgRequestCount: Number(result[1]),
        orgSpendUsd: Number((Number(result[2]) / 100).toFixed(2)),
        orgTokenCount: Number(result[3]),
        toolRequestCount: Number(result[4]),
        toolSpendUsd: Number((Number(result[5]) / 100).toFixed(2)),
        toolTokenCount: Number(result[6]),
      },
    };
  }

  private async readCounter(key: string): Promise<CounterRecord> {
    const record = await this.redis.hgetall(key);
    return {
      requestCount: Number(record.requestCount ?? 0),
      spendCents: Number(record.spendCents ?? 0),
      tokenCount: Number(record.tokenCount ?? 0),
    };
  }

  private getOrgKey(organizationId: string, windowKey: string): string {
    return `usage:org:${organizationId}:${windowKey}`;
  }

  private getToolKey(organizationId: string, toolName: string, windowKey: string): string {
    return `usage:tool:${organizationId}:${toolName}:${windowKey}`;
  }
}
