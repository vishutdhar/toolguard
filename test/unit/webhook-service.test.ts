import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:dns/promises", () => ({
  resolve4: vi.fn(),
  resolve6: vi.fn(),
}));

import http from "node:http";
import type { AddressInfo } from "node:net";
import { resolve4, resolve6 } from "node:dns/promises";
import { deliverWebhook, validateWebhookUrl } from "../../src/services/webhook-service";

const mockResolve4 = vi.mocked(resolve4);
const mockResolve6 = vi.mocked(resolve6);

function noRecords() {
  mockResolve4.mockRejectedValue(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }));
  mockResolve6.mockRejectedValue(Object.assign(new Error("ENODATA"), { code: "ENODATA" }));
}

describe("validateWebhookUrl SSRF hardening (H3)", () => {
  beforeEach(() => {
    mockResolve4.mockReset();
    mockResolve6.mockReset();
  });

  it("throws when the hostname resolves to no IP addresses (fail closed)", async () => {
    noRecords();
    await expect(validateWebhookUrl("https://evil.example.com")).rejects.toThrow();
  });

  it("returns the validated public IP so the caller can pin it", async () => {
    mockResolve4.mockResolvedValue(["93.184.216.34"]);
    mockResolve6.mockRejectedValue(Object.assign(new Error("ENODATA"), { code: "ENODATA" }));

    const result = await validateWebhookUrl("https://example.com/hook");
    expect(result).toMatchObject({ address: "93.184.216.34", family: 4 });
  });

  it("still rejects a hostname that resolves to a private IP", async () => {
    mockResolve4.mockResolvedValue(["10.0.0.5"]);
    mockResolve6.mockRejectedValue(Object.assign(new Error("ENODATA"), { code: "ENODATA" }));

    await expect(validateWebhookUrl("https://sneaky.example.com")).rejects.toThrow();
  });

  it("validates a public IP literal without needing DNS resolution", async () => {
    noRecords(); // resolvers would fail on an IP literal; must not be consulted
    const result = await validateWebhookUrl("https://93.184.216.34/hook");
    expect(result).toMatchObject({ address: "93.184.216.34", family: 4 });
  });

  it("rejects a private IP literal", async () => {
    noRecords();
    await expect(validateWebhookUrl("https://10.0.0.1/hook")).rejects.toThrow();
  });
});

// Exercises the real delivery transport (undici fetch + Agent) with no mocks,
// so an incompatible fetch/Agent pairing or a broken pin fails loudly here.
describe("deliverWebhook transport pinning (H3)", () => {
  it("connects to the pinned IP regardless of the URL hostname", async () => {
    let received = false;
    const server = http.createServer((_req, res) => {
      received = true;
      res.writeHead(200);
      res.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as AddressInfo;

    try {
      // Hostname is a non-loopback name, but the pin forces the connection to
      // the loopback server. If undici fetch and the Agent were incompatible
      // this would throw instead of returning 200.
      const status = await deliverWebhook(`http://pinned-host.example:${port}/`, {
        headers: { "Content-Type": "application/json" },
        body: "{}",
        target: { address: "127.0.0.1", family: 4 },
      });

      expect(status).toBe(200);
      expect(received).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
