import type { DataStore } from "../domain/store";
import type { Run, RunStatus } from "../domain/types";
import type { AuditService } from "./audit-service";

export class RunService {
  constructor(
    private readonly store: DataStore,
    private readonly auditService: AuditService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async create(input: {
    organizationId: string;
    sessionId: string;
    promptSummary?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<Run> {
    const run = await this.store.createRun({
      organizationId: input.organizationId,
      sessionId: input.sessionId,
      promptSummary: input.promptSummary ?? null,
      status: "started",
      metadata: input.metadata ?? {},
    });

    await this.auditService.log({
      organizationId: run.organizationId,
      sessionId: run.sessionId,
      runId: run.id,
      eventType: "run.started",
      actorType: "agent",
      actorId: null,
      payload: {
        promptSummary: run.promptSummary,
      },
      createdAt: run.startedAt,
    });

    return run;
  }

  async complete(runId: string, status: Exclude<RunStatus, "started">): Promise<Run> {
    const completedAt = this.now();
    const run = await this.store.updateRun(runId, { status, completedAt });

    await this.auditService.log({
      organizationId: run.organizationId,
      sessionId: run.sessionId,
      runId: run.id,
      eventType: status === "completed" ? "run.completed" : "run.failed",
      actorType: "agent",
      actorId: null,
      payload: {
        status,
      },
      createdAt: completedAt,
    });

    return run;
  }
}
