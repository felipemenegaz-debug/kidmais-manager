// Campos declarados (sem parameter properties) para o arquivo também rodar nos testes com --experimental-strip-types.
export class AvailabilityServiceError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly details?: unknown;

  constructor(code: string, message: string, httpStatus = 400, details?: unknown) {
    super(message);
    this.name = "AvailabilityServiceError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

export function isAvailabilityServiceError(
  error: unknown,
): error is AvailabilityServiceError {
  return error instanceof AvailabilityServiceError;
}
