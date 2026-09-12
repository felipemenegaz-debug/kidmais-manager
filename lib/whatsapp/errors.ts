export class WhatsappOnboardingError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  constructor(code: string, message: string, httpStatus = 400) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
    this.name = 'WhatsappOnboardingError';
  }
}

export function isWhatsappOnboardingError(error: unknown): error is WhatsappOnboardingError {
  return error instanceof WhatsappOnboardingError;
}
