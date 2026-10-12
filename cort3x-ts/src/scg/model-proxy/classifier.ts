import { ExecutionErrorDetail, RawTransportHeaders } from './types.js';

export class ProviderErrorClassifier {
  /**
   * `context.aborted` is whether the caller's AbortSignal had fired. It is
   * the reliable abort test: the SDKs do not agree on an abort error shape
   * (Anthropic/OpenAI throw APIUserAbortError with name "Error"; Gemini
   * wraps the fetch AbortError in a generic GoogleGenerativeAIError), so
   * an abort used to fall through to protocol_violation.
   */
  static classify(
    error: unknown,
    elapsedMs: number,
    headers?: RawTransportHeaders,
    context: { aborted?: boolean } = {}
  ): ExecutionErrorDetail {
    const err = error as Record<string, any> | undefined;
    const status = Number(err?.status || err?.statusCode || 0);
    const rawCode = String(err?.code || err?.error?.code || err?.type || '').toUpperCase();
    // Anthropic nests the error type one level deeper than OpenAI:
    // { type: 'error', error: { type: 'invalid_request_error' } }.
    const rawType = String(err?.error?.error?.type || err?.error?.type || err?.type || '').toLowerCase();
    const errorClass = String(err?.constructor?.name || '');
    const causeCode = String(err?.cause?.code || '').toUpperCase();
    const message = String(err?.message || err?.error?.message || 'Actuator transmission fault');
    const msgLower = message.toLowerCase();

    const activeHeaders: RawTransportHeaders | undefined = headers || err?.headers;

    if (
      context.aborted ||
      rawCode === 'ABORT_ERR' ||
      err?.name === 'AbortError' ||
      errorClass === 'APIUserAbortError'
    ) {
      return {
        category: 'client_aborted',
        message: 'Execution cycle halted by supervisory signal.',
        code: 'CLIENT_ABORTED',
        failedAtMs: elapsedMs,
        retryable: false,
      };
    }

    if (status === 429 || rawCode.includes('RATE_LIMIT') || rawCode.includes('RESOURCE_EXHAUSTED')) {
      return {
        category: 'capacity',
        message: 'Actuator rate or quota ceiling reached.',
        code: rawCode || '429',
        failedAtMs: elapsedMs,
        // OpenAI's insufficient_quota is a billing limit, not a rate
        // window: retrying cannot succeed until someone adds credit.
        retryable: rawCode !== 'INSUFFICIENT_QUOTA',
        diagnostics: this.extractRateLimitDiagnostics(activeHeaders),
      };
    }

    if (
      rawCode.includes('CONTEXT_LENGTH_EXCEEDED') ||
      rawCode.includes('STRING_ABOVE_MAX_LENGTH') ||
      msgLower.includes('maximum context length') ||
      msgLower.includes('token count exceeds') ||
      msgLower.includes('prompt is too long')
    ) {
      return {
        category: 'context_overflow',
        message: 'Input vector exceeded actuator context capacity.',
        code: rawCode || 'CONTEXT_OVERFLOW',
        failedAtMs: elapsedMs,
        retryable: false,
        diagnostics: { maxTokens: err?.error?.max_tokens },
      };
    }

    if (
      rawType.includes('safety') ||
      rawCode.includes('CONTENT_FILTER') ||
      rawCode.includes('SAFETY') ||
      msgLower.includes('safety policy') ||
      msgLower.includes('blocked by safety')
    ) {
      return {
        category: 'guardrail_trip',
        message: 'Signal blocked by provider behavioral guardrail.',
        code: rawCode || 'GUARDRAIL_TRIP',
        failedAtMs: elapsedMs,
        retryable: false,
      };
    }

    if (status === 400) {
      const isUpstreamTransient =
        msgLower.includes('service unavailable') ||
        msgLower.includes('upstream') ||
        msgLower.includes('timeout') ||
        rawCode === 'SERVER_ERROR' ||
        rawCode === 'TEMPORARY_FAILURE';

      if (isUpstreamTransient) {
        return {
          category: 'transient',
          message: 'Upstream edge rejection masked as Bad Request.',
          code: rawCode || 'UPSTREAM_400_TRANSIENT',
          failedAtMs: elapsedMs,
          retryable: true,
        };
      }

      const isParameterFault =
        rawType === 'invalid_request_error' ||
        rawCode.includes('INVALID_ARGUMENT') ||
        msgLower.includes('invalid temperature') ||
        msgLower.includes('out of range') ||
        msgLower.includes('unknown model') ||
        msgLower.includes('schema validation failed') ||
        msgLower.includes('unrecognized parameter');

      if (isParameterFault) {
        return {
          category: 'invalid_parameters',
          message: `Actuator rejected parameter configuration: ${message.slice(0, 180)}`,
          code: rawCode || 'INVALID_PARAMETER_SPEC',
          failedAtMs: elapsedMs,
          retryable: false,
          diagnostics: { rawErrorType: rawType },
        };
      }
    }

    // Anthropic/OpenAI raise APIConnectionError (no status, no code) when
    // the request never got a response; the socket error is on .cause.
    const isNetworkCode = (c: string) =>
      c === 'ECONNRESET' || c === 'ECONNREFUSED' || c === 'ETIMEDOUT' || c === 'UND_ERR_CONNECT_TIMEOUT' || c === 'EAI_AGAIN';
    if (
      status >= 500 ||
      errorClass === 'APIConnectionError' ||
      errorClass === 'APIConnectionTimeoutError' ||
      isNetworkCode(causeCode) ||
      rawCode === 'ECONNRESET' ||
      rawCode === 'ETIMEDOUT' ||
      rawCode === 'UND_ERR_CONNECT_TIMEOUT' ||
      rawCode === 'EAI_AGAIN'
    ) {
      return {
        category: 'transient',
        message: 'Ephemeral transport or provider host disruption.',
        code: rawCode || String(status),
        failedAtMs: elapsedMs,
        retryable: true,
      };
    }

    return {
      category: 'protocol_violation',
      message: message.slice(0, 256),
      code: rawCode || String(status || 'PROTOCOL_ERROR'),
      failedAtMs: elapsedMs,
      retryable: false,
      diagnostics: { status },
    };
  }

  private static extractRateLimitDiagnostics(headers?: RawTransportHeaders): Record<string, unknown> | undefined {
    if (!headers) return undefined;

    const normalizeHeader = (key: string): string | undefined => {
      const val = headers[key] || headers[key.toLowerCase()];
      return Array.isArray(val) ? val[0] : val;
    };

    const retryAfter = normalizeHeader('retry-after');
    const resetRequests = normalizeHeader('x-ratelimit-reset-requests');
    const resetTokens = normalizeHeader('x-ratelimit-reset-tokens');
    const remainingTokens = normalizeHeader('x-ratelimit-remaining-tokens');
    const remainingRequests = normalizeHeader('x-ratelimit-remaining-requests');

    return {
      retryAfterSeconds: retryAfter ? Number(retryAfter) : undefined,
      resetRequestsWindow: resetRequests,
      resetTokensWindow: resetTokens,
      remainingTokens: remainingTokens ? Number(remainingTokens) : undefined,
      remainingRequests: remainingRequests ? Number(remainingRequests) : undefined,
    };
  }
}
