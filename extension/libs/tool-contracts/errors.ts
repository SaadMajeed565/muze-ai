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
  "TASK_REQUIRED",
  "INTERNAL",
] as const;

export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number];

/**
 * The single teachable task-required message, shared by the extension
 * executor gate and the gateway batch gate (this file is synced into
 * cloudflare/libs, so both sides use this exact sentence). A rejected
 * call never executes, emits no activity row, and consumes no approval
 * budget; the message tells the caller the one fix: create the task.
 */
export const TASK_REQUIRED_MESSAGE =
  "Direct action calls are not accepted. Call tasks.create first with a concise action-first title and the steps as the plan, then let the task run. Single read-only observations do not require a task.";

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
