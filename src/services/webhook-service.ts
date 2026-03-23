import { createHmac } from "node:crypto";
import { resolve4, resolve6 } from "node:dns/promises";
import type { DataStore } from "../domain/store";

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
]);

function isPrivateIpv4(a: number, b: number): boolean {
  if (a === 10) return true;                          // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16.0.0/12
  if (a === 192 && b === 168) return true;             // 192.168.0.0/16
  if (a === 169 && b === 254) return true;             // 169.254.0.0/16 (link-local + cloud metadata)
  if (a === 127) return true;                          // 127.0.0.0/8
  if (a === 0) return true;                            // 0.0.0.0/8
  return false;
}

function isPrivateIp(hostname: string): boolean {
  // Strip brackets for IPv6
  const bare = hostname.replace(/^\[|\]$/g, "");

  // IPv4
  const ipv4Match = bare.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipv4Match) {
    const [, a, b] = ipv4Match.map(Number);
    return isPrivateIpv4(a, b);
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
    const [, a, b] = v4MappedMatch.map(Number);
    return isPrivateIpv4(a, b);
  }

  // IPv4-mapped IPv6 hex form — ::ffff:XXYY:ZZWW
  const v4MappedHexMatch = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (v4MappedHexMatch) {
    const hi = parseInt(v4MappedHexMatch[1], 16);
    const lo = parseInt(v4MappedHexMatch[2], 16);
    const a = (hi >> 8) & 0xff;
    const b = hi & 0xff;
    return isPrivateIpv4(a, b);
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

async function resolveHostnameIps(hostname: string): Promise<string[]> {
  const ips: string[] = [];
  try {
    ips.push(...(await resolve4(hostname)));
  } catch {
    // No A records
  }
  try {
    ips.push(...(await resolve6(hostname)));
  } catch {
    // No AAAA records
  }
  return ips;
}

export async function validateWebhookUrl(url: string, allowInsecure = false): Promise<void> {
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

  // Resolve DNS and validate all returned IPs — blocks rebinding attacks
  // (e.g. 127.0.0.1.nip.io resolves to 127.0.0.1)
  const resolvedIps = await resolveHostnameIps(hostname);
  for (const ip of resolvedIps) {
    if (isPrivateIp(ip)) {
      throw new Error("Webhook URL must not resolve to private or reserved addresses");
    }
  }
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
        // Re-validate at delivery time — DNS records may have changed since registration
        await validateWebhookUrl(config.url, this.allowInsecureUrls);

        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (config.secret) {
          headers["X-ToolGuard-Signature"] = createHmac("sha256", config.secret)
            .update(body)
            .digest("hex");
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10_000);
        try {
          await fetch(config.url, {
            method: "POST",
            headers,
            body,
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeout);
        }
      }),
    );
  }
}
