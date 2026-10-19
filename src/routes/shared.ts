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

// Enforce that the calling key carries a capability. Keys with ["*"] pass any
// check; a key minted with a restricted scope list is refused unless it lists
// the exact capability (separation of duties for sensitive routes).
export function requireCapability(auth: AuthContext, capability: string): void {
  const scopes = auth.apiKey.scopes ?? [];
  if (scopes.includes("*") || scopes.includes(capability)) {
    return;
  }
  throw new AppError(`API key is missing the required capability: ${capability}`, 403, "CAPABILITY_REQUIRED");
}

// A key may only mint keys whose scopes are a subset of its own. A caller with
// ["*"] may grant anything; any other caller may grant only scopes it holds
// verbatim, and never "*". An empty list is refused because the key store
// treats an empty scope list as full access.
export function assertScopesWithinCaller(auth: AuthContext, requested: string[]): void {
  if (requested.length === 0) {
    throw new AppError("scopes must contain at least one capability", 400, "INVALID_SCOPES");
  }
  const callerScopes = auth.apiKey.scopes ?? [];
  if (callerScopes.includes("*")) {
    return;
  }
  const notHeld = requested.filter((scope) => !callerScopes.includes(scope));
  if (notHeld.length > 0) {
    throw new AppError(
      "Requested scopes exceed the calling API key's scopes",
      403,
      "SCOPE_ESCALATION",
      { notHeld },
    );
  }
}

export function assertSelfSignupAllowed(allowed: boolean): void {
  if (!allowed) {
    throw new AppError("Organization self-signup is disabled", 403, "SELF_SIGNUP_DISABLED");
  }
}

export function asRecord(value: Record<string, unknown> | undefined): Record<string, unknown> {
  return value ?? {};
}
