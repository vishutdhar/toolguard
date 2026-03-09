import { notFound } from "../lib/errors";
import type { DataStore } from "../domain/store";
import type { AuditEvent } from "../domain/types";

export interface ReplayTimelineItem {
  timestamp: string;
  eventType: string;
  summary: string;
  payload: Record<string, unknown>;
}

function summarize(event: AuditEvent): string {
  switch (event.eventType) {
    case "run.started":
      return "Run started";
    case "tool.authorization.requested":
      return "Tool authorization requested";
    case "policy.evaluated":
      return "Policy decision recorded";
    case "approval.requested":
      return "Approval requested";
    case "approval.resolved":
      return "Approval resolved";
    case "approval.expired":
      return "Approval expired";
    case "tool.authorized":
      return "Tool authorized";
    case "tool.denied":
      return "Tool denied";
    case "run.completed":
      return "Run completed";
    case "run.failed":
      return "Run failed";
    default:
      return event.eventType;
  }
}

export class ReplayService {
  constructor(private readonly store: DataStore) {}

  async replay(runId: string): Promise<ReplayTimelineItem[]> {
    const run = await this.store.getRun(runId);
    if (!run) {
      throw notFound("Run", { runId });
    }

    const events = await this.store.listAuditEventsForRun(runId);
    return events
      .filter(
        (event) =>
          event.organizationId === run.organizationId &&
          (event.sessionId === null || event.sessionId === run.sessionId),
      )
      .map((event) => ({
      timestamp: event.createdAt.toISOString(),
      eventType: event.eventType,
      summary: summarize(event),
      payload: event.payload,
      }));
  }
}
