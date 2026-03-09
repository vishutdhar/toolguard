/**
 * Validates that the openai SDK works correctly with zod 4 in the dependency tree.
 *
 * The root project overrides openai's zod peer from ^3.23.8 to the project's zod ^4.x.
 *
 * Our SDK uses openai.chat.completions.create() which returns plain JSON parsed by fetch —
 * zod is never invoked on that path. The zod peer dependency is only used by openai's
 * structured outputs feature (zodResponseFormat / .parse()). These tests verify that
 * the override does not break any code path we depend on.
 */
import { describe, it, expect } from "vitest";

describe("openai SDK + zod 4 compatibility", () => {
  it("openai module loads and client instantiates with zod 4 in the tree", async () => {
    // Dynamic import proves the module loads at runtime (not just type-checks)
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({ apiKey: "sk-test-not-real" });

    expect(client).toBeDefined();
    expect(typeof client.chat.completions.create).toBe("function");
  });

  it("zod override is active — installed version is 4.x", async () => {
    // If this fails, the npm override in package.json is not working
    const zod = await import("zod");
    // zod 4 exports a version string or we can check for zod 4-specific APIs
    // zod 4 uses z.string() returning a ZodString with _zod property
    const schema = zod.z.string();
    // zod 4 schemas have a ~standard property (Standard Schema), zod 3 does not
    expect("~standard" in schema).toBe(true);
  });

  it("openai response types can be imported at runtime", async () => {
    // Dynamic imports prove the module subpaths resolve and load
    const completions = await import("openai/resources/chat/completions");

    // These are runtime module exports, not just type annotations
    expect(completions).toBeDefined();
  });

  it("openai APIError class works at runtime (zod-independent error path)", async () => {
    const { APIError } = await import("openai");
    const err = new APIError(
      401,
      { error: { message: "Invalid API key", type: "invalid_request_error" } },
      "Invalid API key",
      {},
    );
    expect(err).toBeInstanceOf(APIError);
    expect(err.status).toBe(401);
  });
});
