// Maximum number of audit events a single run's replay will load into memory.
// Bounds the /v1/runs/:runId/replay endpoint so a long-lived run cannot force an
// unbounded query (see listAuditEventsForRun in the data stores).
export const AUDIT_EVENTS_FOR_RUN_LIMIT = 1000;
