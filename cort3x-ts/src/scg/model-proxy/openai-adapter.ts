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

export class OpenAIProviderAdapter implements IModelProviderAdapter {
  readonly provider = 'openai' as const;

  constructor(private readonly client: any) {}

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

    const messages = [
      { role: 'system', content: systemDirective },
      { role: 'user', content: envelope.input.primaryText },
    ];

    const self = this;

    async function* streamGenerator(): AsyncIterable<string> {
      let caughtError: unknown = undefined;
      let capturedHeaders: RawTransportHeaders | undefined = undefined;
      let aggregatedResponse: any = {
        id: undefined,
        choices: [{ finish_reason: undefined }],
        usage: undefined,
      };

      try {
        const stream = await self.client.chat.completions.create(
          {
            model: envelope.target.modelId,
            messages: messages,
            temperature: envelope.target.parameters.temperature,
            top_p: envelope.target.parameters.topP,
            max_tokens: envelope.target.parameters.maxOutputTokens,
            stop: envelope.target.parameters.stopSequences,
            stream: true,
            stream_options: { include_usage: true },
          },
          { signal: abortSignal }
        );

        for await (const chunk of stream) {
          if (chunk.id) aggregatedResponse.id = chunk.id;
          
          const choice = chunk.choices?.[0];
          if (choice?.finish_reason) {
            aggregatedResponse.choices[0].finish_reason = choice.finish_reason;
          }

          if (chunk.usage) {
            aggregatedResponse.usage = chunk.usage;
          }

          const deltaText = choice?.delta?.content;
          if (deltaText) {
            yield deltaText;
          }
        }
      } catch (err: any) {
        caughtError = err;
        capturedHeaders = err?.headers || err?.response?.headers;
      } finally {
        const elapsedMs = Math.round(performance.now() - startMark);
        const metrics = self.normalizeExecution(
          {
            response: aggregatedResponse,
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
    const choice = resp?.choices?.[0];
    const rawFinishReason = choice?.finish_reason;

    if (rawFinishReason === 'content_filter') {
      return {
        latencyMs: elapsedMs,
        inputTokens: resp?.usage?.prompt_tokens ?? 0,
        outputTokens: resp?.usage?.completion_tokens ?? 0,
        finishReason: 'content_filter',
        rawProviderRequestId: resp?.id,
        error: {
          category: 'guardrail_trip',
          message: 'Actuator halted stream: content filter triggered mid-generation.',
          code: 'CONTENT_FILTER',
          failedAtMs: elapsedMs,
          retryable: false,
          diagnostics: { finishReason: rawFinishReason },
        },
      };
    }

    return {
      latencyMs: elapsedMs,
      inputTokens: resp?.usage?.prompt_tokens ?? 0,
      outputTokens: resp?.usage?.completion_tokens ?? 0,
      finishReason: this.mapFinishReason(rawFinishReason),
      rawProviderRequestId: resp?.id,
    };
  }

  private mapFinishReason(rawReason?: string): ExecutionFinishReason {
    switch (rawReason) {
      case 'stop':
        return 'completed';
      case 'length':
        return 'length_exceeded';
      default:
        return 'unknown';
    }
  }
}
