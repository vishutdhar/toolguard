import { z } from "zod";
import { AppError, assertApp } from "../lib/errors";
import type { AuthContext } from "../services/auth-service";

export const metadataSchema = z.record(z.string(), z.unknown()).default({});
export const stringArraySchema = z.array(z.string()).default([]);
export const riskLevelSchema = z.enum(["low", "medium", "high"]);
export const decisionSchema = z.enum(["allow", "deny", "require_approval"]);

export function requireOrgAccess(auth: AuthContext, orgId: string): void {
  assertApp(auth.organization.id === orgId, "Organization access denied", 403, "ORG_ACCESS_DENIED");
}

export function assertSelfSignupAllowed(allowed: boolean): void {
  if (!allowed) {
    throw new AppError("Organization self-signup is disabled", 403, "SELF_SIGNUP_DISABLED");
  }
}

export function asRecord(value: Record<string, unknown> | undefined): Record<string, unknown> {
  return value ?? {};
}
