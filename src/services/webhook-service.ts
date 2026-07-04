import { createHmac } from "node:crypto";
import { resolve4, resolve6 } from "node:dns/promises";
// Use undici's own fetch together with its Agent. Node's GLOBAL fetch is backed
// by a different (bundled) undici build, and passing an external Agent as its
// dispatcher throws UND_ERR_INVALID_ARG. Keeping both from the same package
// guarantees the dispatcher and fetch implementation are compatible.
import { Agent, fetch as undiciFetch } from "undici";
import type { DataStore } from "../domain/store";

export interface PinnedTarget {
  address: string;
  family: 4 | 6;
}

// A DNS lookup shim that always returns the pre-validated IP, forcing every
// connection attempt onto that exact address while the original hostname is
// still used for TLS SNI and the Host header.
function pinnedLookup(target: PinnedTarget) {
  return (_hostname: string, options: { all?: boolean }, callback: (err: Error | null, address: unknown, family?: number) => void) => {
    if (options?.all) {
      callback(null, [{ address: target.address, family: target.family }]);
    } else {
      callback(null, target.address, target.family);
    }
  };
}

// Delivers a webhook POST to the given URL while pinning the outbound connection
// to the pre-validated IP (closing DNS rebinding). Exported so the transport can
// be exercised against a real loopback server in tests.
export async function deliverWebhook(
  url: string,
  options: { headers: Record<string, string>; body: string; target: PinnedTarget; timeoutMs?: number },
): Promise<number> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  const dispatcher = new Agent({ connect: { lookup: pinnedLookup(options.target) as never } });
  try {
    const response = await undiciFetch(url, {
      method: "POST",
      headers: options.headers,
      body: options.body,
      signal: controller.signal,
      redirect: "error",
      dispatcher,
    });
    return response.status;
  } finally {
    clearTimeout(timeout);
    await dispatcher.close().catch(() => {});
  }
}

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
]);

function isPrivateOrReservedIpv4(a: number, b: number, c: number): boolean {
  if (a === 10) return true;                          // 10.0.0.0/8 — Private (RFC 1918)
  if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16.0.0/12 — Private (RFC 1918)
  if (a === 192 && b === 168) return true;             // 192.168.0.0/16 — Private (RFC 1918)
  if (a === 169 && b === 254) return true;             // 169.254.0.0/16 — Link-local + cloud metadata
  if (a === 127) return true;                          // 127.0.0.0/8 — Loopback
  if (a === 0) return true;                            // 0.0.0.0/8 — "This" network
  if (a === 100 && b >= 64 && b <= 127) return true;   // 100.64.0.0/10 — CGNAT (RFC 6598)
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 — Benchmarking (RFC 2544)
  if (a >= 224) return true;                           // 224.0.0.0/4 — Multicast + 240.0.0.0/4 — Reserved
  if (a === 192 && b === 0 && c === 0) return true;    // 192.0.0.0/24 — IETF Protocol Assignments
  if (a === 192 && b === 0 && c === 2) return true;    // 192.0.2.0/24 — Documentation (RFC 5737)
  if (a === 198 && b === 51 && c === 100) return true;  // 198.51.100.0/24 — Documentation (RFC 5737)
  if (a === 203 && b === 0 && c === 113) return true;   // 203.0.113.0/24 — Documentation (RFC 5737)
  return false;
}

function isPrivateIp(hostname: string): boolean {
  // Strip brackets for IPv6
  const bare = hostname.replace(/^\[|\]$/g, "");

  // IPv4
  const ipv4Match = bare.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipv4Match) {
    const [, a, b, c] = ipv4Match.map(Number);
    return isPrivateOrReservedIpv4(a, b, c);
  }

  // Normalize IPv6 for analysis
  const lower = bare.toLowerCase();

  // Loopback ::1
  if (lower === "::1" || lower === "0000:0000:0000:0000:0000:0000:0000:0001") return true;

  // Unspecified ::
  if (lower === "::" || lower === "0000:0000:0000:0000:0000:0000:0000:0000") return true;

  // IPv4-mapped IPv6 — ::ffff:A.B.C.D
  const v4MappedMatch = lower.match(/^::ffff:(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4MappedMatch) {
    const [, a, b, c] = v4MappedMatch.map(Number);
    return isPrivateOrReservedIpv4(a, b, c);
  }

  // IPv4-mapped IPv6 hex form — ::ffff:XXYY:ZZWW
  const v4MappedHexMatch = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (v4MappedHexMatch) {
    const hi = parseInt(v4MappedHexMatch[1], 16);
    const lo = parseInt(v4MappedHexMatch[2], 16);
    const a = (hi >> 8) & 0xff;
    const b = hi & 0xff;
    const c = (lo >> 8) & 0xff;
    return isPrivateOrReservedIpv4(a, b, c);
  }

  // IPv6 private/reserved prefixes
  // Extract the first group to check prefix
  const firstGroup = lower.split(":")[0];
  if (firstGroup) {
    const val = parseInt(firstGroup, 16);
    if (!isNaN(val)) {
      // fc00::/7 — Unique Local Addresses (fd00::/8 and fc00::/8)
      if ((val & 0xfe00) === 0xfc00) return true;
      // fe80::/10 — Link-Local
      if ((val & 0xffc0) === 0xfe80) return true;
    }
  }

  return false;
}

async function resolveHostnameIps(hostname: string): Promise<{ v4: string[]; v6: string[] }> {
  let v4: string[] = [];
  let v6: string[] = [];
  try {
    v4 = await resolve4(hostname);
  } catch {
    // No A records
  }
  try {
    v6 = await resolve6(hostname);
  } catch {
    // No AAAA records
  }
  return { v4, v6 };
}

// Returns 4/6 when the host is an IP literal (already validated by isPrivateIp),
// or null when it is a hostname that must be resolved.
function ipLiteralFamily(hostname: string): 4 | 6 | null {
  const bare = hostname.replace(/^\[|\]$/g, "");
  if (/^\d+\.\d+\.\d+\.\d+$/.test(bare)) return 4;
  if (bare.includes(":")) return 6;
  return null;
}

// Validates a webhook URL and returns the exact IP the caller must connect to.
// Callers MUST pin this address for the outbound request; re-resolving the
// hostname at connect time reopens the DNS-rebinding hole this check closes (H3).
export async function validateWebhookUrl(url: string, allowInsecure = false): Promise<PinnedTarget> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid webhook URL");
  }

  if (!allowInsecure && parsed.protocol !== "https:") {
    throw new Error("Webhook URL must use HTTPS");
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Webhook URL must use HTTPS or HTTP");
  }

  // Normalize: strip trailing dot (DNS FQDN equivalence) and lowercase
  const hostname = parsed.hostname.toLowerCase().replace(/\.+$/, "");
  if (BLOCKED_HOSTNAMES.has(hostname) || isPrivateIp(hostname)) {
    throw new Error("Webhook URL must not target private or reserved addresses");
  }

  // IP-literal host: already validated above, pin it directly (no DNS involved).
  const literalFamily = ipLiteralFamily(hostname);
  if (literalFamily) {
    return { address: hostname.replace(/^\[|\]$/g, ""), family: literalFamily };
  }

  // Resolve DNS and validate every returned IP — blocks rebinding via records
  // that point at private space (e.g. 127.0.0.1.nip.io).
  const { v4, v6 } = await resolveHostnameIps(hostname);
  const resolvedIps = [...v4, ...v6];

  // Fail closed: a host that resolves to nothing cannot be proven safe, and
  // letting it through would hand an unvalidated name to the HTTP client to
  // resolve however it likes.
  if (resolvedIps.length === 0) {
    throw new Error("Webhook URL host could not be resolved to any address");
  }

  for (const ip of resolvedIps) {
    if (isPrivateIp(ip)) {
      throw new Error("Webhook URL must not resolve to private or reserved addresses");
    }
  }

  // Pin the first validated address (prefer IPv4 when both exist).
  const address = v4[0] ?? v6[0];
  return { address, family: v4[0] ? 4 : 6 };
}

export class WebhookService {
  constructor(
    private readonly store: DataStore,
    private readonly allowInsecureUrls = false,
  ) {}

  async fireEvent(
    organizationId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const configs = await this.store.listWebhookConfigs(organizationId);
    const matching = configs.filter(
      (c) => c.eventTypes.includes("*") || c.eventTypes.includes(eventType),
    );

    if (matching.length === 0) return;

    const body = JSON.stringify({ eventType, payload, timestamp: new Date().toISOString() });

    await Promise.allSettled(
      matching.map(async (config) => {
        // Re-validate at delivery time and pin the resulting IP so the outbound
        // connection goes to the exact address we just checked. Without pinning,
        // the HTTP client would re-resolve the hostname, reopening DNS rebinding.
        const target = await validateWebhookUrl(config.url, this.allowInsecureUrls);

        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (config.secret) {
          headers["X-ToolGuard-Signature"] = createHmac("sha256", config.secret)
            .update(body)
            .digest("hex");
        }

        await deliverWebhook(config.url, { headers, body, target });
      }),
    );
  }
}
