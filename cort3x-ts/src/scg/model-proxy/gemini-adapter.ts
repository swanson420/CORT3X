import { 
  IModelProviderAdapter, 
  PromptEnvelopeDTO, 
  RawExecutionResult, 
  ExecutionMetrics, 
  ExecutionFinishReason, 
  RawTransportHeaders, 
  DispatchedExecution 
} from './types.js';
import { ProviderErrorClassifier } from './classifier.js';

export class GeminiProviderAdapter implements IModelProviderAdapter {
  readonly provider = 'google' as const;

  constructor(private readonly aiClient: any) {}

  dispatch(
    envelope: PromptEnvelopeDTO,
    abortSignal?: AbortSignal
  ): DispatchedExecution {
    const startMark = performance.now();
    let resolveMetrics!: (metrics: ExecutionMetrics) => void;
    const completed = new Promise<ExecutionMetrics>((resolve) => {
      resolveMetrics = resolve;
    });

    const systemDirective = [
      `ROLE: ${envelope.directives.roleProfile}`,
      `GOGGLES: ${envelope.directives.activeGoggle}`,
      `LENS: ${envelope.directives.activeLens}`,
      envelope.directives.systemInstructions,
    ].filter(Boolean).join('\n\n');

    const model = this.aiClient.getGenerativeModel({
      model: envelope.target.modelId,
      systemInstruction: systemDirective,
      generationConfig: {
        temperature: envelope.target.parameters.temperature,
        topP: envelope.target.parameters.topP,
        maxOutputTokens: envelope.target.parameters.maxOutputTokens,
        stopSequences: envelope.target.parameters.stopSequences
          ? [...envelope.target.parameters.stopSequences]
          : undefined,
      },
    });

    const self = this;

    async function* streamGenerator(): AsyncIterable<string> {
      let caughtError: unknown = undefined;
      let capturedHeaders: RawTransportHeaders | undefined = undefined;
      let finalResponseObj: any = undefined;

      try {
        const responseStream = await model.generateContentStream(
          { contents: [{ role: 'user', parts: [{ text: envelope.input.primaryText }] }] },
          { signal: abortSignal }
        );

        for await (const chunk of responseStream.stream) {
          const candidate = chunk.candidates?.[0];
          const finishReason = candidate?.finishReason;

          if (finishReason && finishReason !== 'STOP' && finishReason !== 'MAX_TOKENS') {
            break;
          }

          let textChunk: string | undefined;
          try {
            textChunk = chunk.text();
          } catch {
            break;
          }

          if (textChunk) {
            yield textChunk;
          }
        }

        try {
          finalResponseObj = await responseStream.response;
        } catch (respErr) {
          if (!caughtError) caughtError = respErr;
        }
      } catch (err: any) {
        caughtError = err;
        capturedHeaders = err?.headers || err?.response?.headers;
      } finally {
        const elapsedMs = Math.round(performance.now() - startMark);
        const metrics = self.normalizeExecution(
          {
            response: finalResponseObj,
            error: caughtError,
            headers: capturedHeaders,
            aborted: abortSignal?.aborted ?? false,
          },
          elapsedMs
        );
        resolveMetrics(metrics);
      }
    }

    return {
      stream: streamGenerator(),
      completed,
    };
  }

  normalizeExecution(
    rawResult: RawExecutionResult,
    elapsedMs: number
  ): ExecutionMetrics {
    if (rawResult.error) {
      const errObj = rawResult.error as Record<string, any> | undefined;
      const responseHeaders: RawTransportHeaders | undefined =
        rawResult.headers || errObj?.headers || errObj?.response?.headers;

      const errorDetail = ProviderErrorClassifier.classify(
        rawResult.error,
        elapsedMs,
        responseHeaders,
        { aborted: rawResult.aborted }
      );

      return {
        latencyMs: elapsedMs,
        finishReason: errorDetail.category === 'client_aborted' ? 'aborted' : 'error',
        error: errorDetail,
      };
    }

    const resp = rawResult.response;
    const promptFeedback = resp?.promptFeedback;
    if (promptFeedback?.blockReason) {
      return {
        latencyMs: elapsedMs,
        inputTokens: resp?.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: 0,
        finishReason: 'content_filter',
        rawProviderRequestId: resp?.responseId,
        error: {
          category: 'guardrail_trip',
          message: `Prompt rejected by Gemini safety policy: ${promptFeedback.blockReason}`,
          code: `PROMPT_BLOCKED_${promptFeedback.blockReason}`,
          failedAtMs: elapsedMs,
          retryable: false,
          diagnostics: {
            blockReason: promptFeedback.blockReason,
            safetyRatings: this.normalizeSafetyRatings(promptFeedback.safetyRatings),
          },
        },
      };
    }

    const candidate = resp?.candidates?.[0];
    const rawFinishReason = candidate?.finishReason;

    if (
      rawFinishReason === 'SAFETY' ||
      rawFinishReason === 'RECITATION' ||
      rawFinishReason === 'BLOCKLIST'
    ) {
      return {
        latencyMs: elapsedMs,
        inputTokens: resp?.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: resp?.usageMetadata?.candidatesTokenCount ?? 0,
        finishReason: 'content_filter',
        rawProviderRequestId: resp?.responseId,
        error: {
          category: 'guardrail_trip',
          message: `Generation halted by actuator guardrail: ${rawFinishReason}`,
          code: `CANDIDATE_HALTED_${rawFinishReason}`,
          failedAtMs: elapsedMs,
          retryable: false,
          diagnostics: {
            finishReason: rawFinishReason,
            safetyRatings: this.normalizeSafetyRatings(candidate?.safetyRatings),
            citationMetadata: candidate?.citationMetadata,
          },
        },
      };
    }

    return {
      latencyMs: elapsedMs,
      inputTokens: resp?.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: resp?.usageMetadata?.candidatesTokenCount ?? 0,
      finishReason: this.mapFinishReason(rawFinishReason),
      rawProviderRequestId: resp?.responseId,
    };
  }

  private normalizeSafetyRatings(
    ratings?: any[]
  ): Record<string, { probability: string; blocked?: boolean }> | undefined {
    if (!Array.isArray(ratings) || ratings.length === 0) return undefined;
    const normalized: Record<string, { probability: string; blocked?: boolean }> = {};
    for (const rating of ratings) {
      if (rating?.category) {
        normalized[rating.category] = {
          probability: rating.probability ?? 'UNKNOWN',
          blocked: rating.blocked ?? false,
        };
      }
    }
    return normalized;
  }

  private mapFinishReason(rawReason?: string): ExecutionFinishReason {
    switch (rawReason) {
      case 'STOP':
        return 'completed';
      case 'MAX_TOKENS':
        return 'length_exceeded';
      default:
        return 'unknown';
    }
  }
}
