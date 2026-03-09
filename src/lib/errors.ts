export class AppError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 400,
    public readonly code = "BAD_REQUEST",
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function assertApp(
  condition: unknown,
  message: string,
  statusCode = 400,
  code = "BAD_REQUEST",
  details?: Record<string, unknown>,
): asserts condition {
  if (!condition) {
    throw new AppError(message, statusCode, code, details);
  }
}

export function notFound(resource: string, details?: Record<string, unknown>): AppError {
  return new AppError(`${resource} not found`, 404, "NOT_FOUND", details);
}
