export const TOOL_ERROR_CODES = [
  "INVALID_INPUT",
  "PERMISSION_DENIED",
  "APPROVAL_REQUIRED",
  "APPROVAL_DENIED",
  "APPROVAL_EXPIRED",
  "UNAUTHORIZED",
  "TOOL_NOT_FOUND",
  "RESTRICTED_PAGE",
  "INVALID_URL",
  "NOT_FOUND",
  "AMBIGUOUS_ELEMENT",
  "STALE_ELEMENT",
  "NAVIGATION_FAILED",
  "TIMEOUT",
  "CANCELLED",
  "RATE_LIMITED",
  "UNSUPPORTED",
  "CONFLICT",
  "KILL_SWITCH",
  "INTERNAL",
] as const;

export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number];

export interface ToolError {
  code: ToolErrorCode;
  message: string;
  /** Optional, non-sensitive structured context (never include secrets). */
  details?: Record<string, unknown>;
  /** Whether the client may safely retry the same call. */
  retryable: boolean;
}

export class ToolErrorException extends Error {
  readonly code: ToolErrorCode;
  readonly details?: Record<string, unknown>;
  readonly retryable: boolean;

  constructor(code: ToolErrorCode, message: string, options?: { details?: Record<string, unknown>; retryable?: boolean }) {
    super(message);
    this.name = "ToolErrorException";
    this.code = code;
    this.details = options?.details;
    this.retryable = options?.retryable ?? false;
  }

  toToolError(): ToolError {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details ? { details: this.details } : {}),
    };
  }

  static is(value: unknown): value is ToolErrorException {
    return value instanceof ToolErrorException;
  }
}

export function toToolError(error: unknown): ToolError {
  if (ToolErrorException.is(error)) return error.toToolError();
  if (error instanceof Error) {
    return { code: "INTERNAL", message: error.message, retryable: false };
  }
  return { code: "INTERNAL", message: String(error), retryable: false };
}
