import type { DataStore } from "../domain/store";
import type { AuditEvent } from "../domain/types";

export interface AuditLogInput {
  organizationId: string;
  sessionId?: string | null;
  runId?: string | null;
  eventType: string;
  actorType: string;
  actorId?: string | null;
  payload: Record<string, unknown>;
  createdAt?: Date;
}

export class AuditService {
  constructor(private readonly store: DataStore) {}

  async log(input: AuditLogInput): Promise<AuditEvent> {
    return this.store.createAuditEvent(input);
  }
}
