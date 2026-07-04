import { describe, expect, it } from "vitest";
import { MemoryDataStore } from "../../src/infrastructure/memory/store";
import { AUDIT_EVENTS_FOR_RUN_LIMIT } from "../../src/domain/constants";

// L3: listAuditEventsForRun had no bound, letting the replay endpoint load an
// entire run's audit trail into memory.
describe("listAuditEventsForRun bounding (L3)", () => {
  it("caps the number of returned events", async () => {
    const store = new MemoryDataStore();
    for (let i = 0; i < AUDIT_EVENTS_FOR_RUN_LIMIT + 5; i++) {
      await store.createAuditEvent({
        organizationId: "o",
        runId: "run_x",
        eventType: "tool.authorized",
        actorType: "system",
        payload: {},
      });
    }

    const events = await store.listAuditEventsForRun("run_x");
    expect(events.length).toBe(AUDIT_EVENTS_FOR_RUN_LIMIT);
  });
});
