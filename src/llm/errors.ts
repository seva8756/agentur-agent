type LlmErrorLike = {
  message?: unknown;
  status?: unknown;
  code?: unknown;
  type?: unknown;
  error?: {
    message?: unknown;
    status?: unknown;
    code?: unknown;
    type?: unknown;
  };
};

export function getLlmErrorDetails(error: unknown): { status?: number; text: string } {
  const candidate = error as LlmErrorLike | undefined;
  return {
    status: firstNumber(candidate?.status, candidate?.error?.status),
    text: [
      candidate?.message,
      candidate?.error?.message,
      candidate?.code,
      candidate?.error?.code,
      candidate?.type,
      candidate?.error?.type,
    ].filter(isString).join(' ').toLowerCase(),
  };
}

export function isRetryableLlmTransportError(error: unknown): boolean {
  const { status, text } = getLlmErrorDetails(error);
  return (
    text.includes('timeout') ||
    text.includes('timed out') ||
    status === 408 ||
    status === 429 ||
    isServerError(status)
  );
}

export function isLlmContextLengthError(error: unknown): boolean {
  const { status, text } = getLlmErrorDetails(error);
  return (
    status === 400 &&
    (
      text.includes('maximum context length') ||
      text.includes('context length') ||
      text.includes('context_length_exceeded') ||
      (text.includes('tokens') && text.includes('prompt'))
    )
  );
}

function firstNumber(...values: unknown[]): number | undefined {
  return values.find((value): value is number => typeof value === 'number');
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isServerError(status: number | undefined): boolean {
  return status !== undefined && status >= 500 && status < 600;
}
