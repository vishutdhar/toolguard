import { describe, expect, it } from "vitest";
import { getEnv } from "../../src/config/env";

// M1: z.coerce.boolean() treats any non-empty string as true, so "false"/"0"
// could never disable ENABLE_SWAGGER / ALLOW_SELF_SIGNUP / BULLMQ_ENABLED.
describe("env boolean flags (M1)", () => {
  it('parses ENABLE_SWAGGER="false" as false', () => {
    expect(getEnv({ ENABLE_SWAGGER: "false" } as NodeJS.ProcessEnv).ENABLE_SWAGGER).toBe(false);
  });

  it('parses ALLOW_SELF_SIGNUP="false" as false', () => {
    expect(getEnv({ ALLOW_SELF_SIGNUP: "false" } as NodeJS.ProcessEnv).ALLOW_SELF_SIGNUP).toBe(false);
  });

  it('parses BULLMQ_ENABLED="0" as false', () => {
    expect(getEnv({ BULLMQ_ENABLED: "0" } as NodeJS.ProcessEnv).BULLMQ_ENABLED).toBe(false);
  });

  it('parses "true" and "1" as true', () => {
    expect(getEnv({ ENABLE_SWAGGER: "true" } as NodeJS.ProcessEnv).ENABLE_SWAGGER).toBe(true);
    expect(getEnv({ ENABLE_SWAGGER: "1" } as NodeJS.ProcessEnv).ENABLE_SWAGGER).toBe(true);
  });

  it("defaults to true when unset", () => {
    expect(getEnv({} as NodeJS.ProcessEnv).ENABLE_SWAGGER).toBe(true);
  });
});
