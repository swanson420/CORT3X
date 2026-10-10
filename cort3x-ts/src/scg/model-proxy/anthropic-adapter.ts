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

export class AnthropicProviderAdapter implements IModelProviderAdapter {
  readonly provider = 'anthropic' as const;

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
      {
        role: 'user',
        content: envelope.input.primaryText,
      },
    ];

    const self = this;

    async function* streamGenerator(): AsyncIterable<string> {
      let finalMessageState: any = undefined;
      let caughtError: unknown = undefined;
      let capturedHeaders: RawTransportHeaders | undefined = undefined;

      try {
        const stream = await self.client.messages.create(
          {
            model: envelope.target.modelId,
            max_tokens: envelope.target.parameters.maxOutputTokens ?? 4096,
            temperature: envelope.target.parameters.temperature,
            top_p: envelope.target.parameters.topP,
            system: systemDirective,
            messages: messages,
            stream: true,
          },
          { signal: abortSignal }
        );

        for await (const event of stream) {
          if (event.type === 'message_start') {
            finalMessageState = event.message;
          } else if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            yield event.delta.text;
          } else if (event.type === 'message_delta') {
            if (finalMessageState) {
              finalMessageState.stop_reason = event.delta?.stop_reason ?? finalMessageState.stop_reason;
              if (event.usage) {
                finalMessageState.usage = {
                  ...finalMessageState.usage,
                  ...event.usage,
                };
              }
            }
          }
        }
      } catch (err: any) {
        caughtError = err;
        capturedHeaders = err?.headers || err?.response?.headers;
      } finally {
        const elapsedMs = Math.round(performance.now() - startMark);
        const metrics = self.normalizeExecution(
          {
            response: finalMessageState,
            error: caughtError,
            headers: capturedHeaders,
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
        responseHeaders
      );

      return {
        latencyMs: elapsedMs,
        finishReason: errorDetail.category === 'client_aborted' ? 'aborted' : 'error',
        error: errorDetail,
      };
    }

    const resp = rawResult.response;
    return {
      latencyMs: elapsedMs,
      inputTokens: resp?.usage?.input_tokens ?? 0,
      outputTokens: resp?.usage?.output_tokens ?? 0,
      finishReason: this.mapFinishReason(resp?.stop_reason),
      rawProviderRequestId: resp?.id,
    };
  }

  private mapFinishReason(stopReason?: string): ExecutionFinishReason {
    switch (stopReason) {
      case 'end_turn':
      case 'stop_sequence':
        return 'completed';
      case 'max_tokens':
        return 'length_exceeded';
      default:
        return 'unknown';
    }
  }
}
