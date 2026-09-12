export class AvailabilityServiceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AvailabilityServiceError";
  }
}

export function isAvailabilityServiceError(
  error: unknown,
): error is AvailabilityServiceError {
  return error instanceof AvailabilityServiceError;
}
