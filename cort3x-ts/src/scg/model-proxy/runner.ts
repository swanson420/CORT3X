import { 
  PromptEnvelopeDTO, 
  NodeArtifact, 
  ExecutionMetrics 
} from './types.js';
import { ProviderAdapterFactory } from './factory.js';

export interface ExecutionEventStream {
  /** Asynchronous iterator emitting text tokens to the client/observer */
  readonly tokenStream: AsyncIterable<string>;
  /** 
   * Authoritative promise that settles when the backend completes intake,
   * completely decoupled from whether the client stays connected to tokenStream.
   */
  readonly completion: Promise<{
    readonly artifact?: NodeArtifact;
    readonly metrics: ExecutionMetrics;
  }>;
}

export class NodeExecutionRunner {
  constructor(private readonly adapterFactory: ProviderAdapterFactory) {}

  execute(
    envelope: PromptEnvelopeDTO,
    abortSignal?: AbortSignal
  ): ExecutionEventStream {
    const adapter = this.adapterFactory.getAdapter(envelope.target.provider);
    const dispatchResult = adapter.dispatch(envelope, abortSignal);

    let resolveCompletion!: (value: { artifact?: NodeArtifact; metrics: ExecutionMetrics }) => void;
    let rejectCompletion!: (reason: unknown) => void;

    const completionPromise = new Promise<{ artifact?: NodeArtifact; metrics: ExecutionMetrics }>(
      (resolve, reject) => {
        resolveCompletion = resolve;
        rejectCompletion = reject;
      }
    );

    type QueueItem = 
      | { type: 'chunk'; value: string }
      | { type: 'done' }
      | { type: 'error'; error: unknown };

    const queue: QueueItem[] = [];
    let pendingReaderResolve: ((item: QueueItem) => void) | null = null;
    let observerAttached = false;
    let observerDetached = false;

    function pushToObserver(item: QueueItem) {
      if (!observerAttached || observerDetached) return;

      if (pendingReaderResolve) {
        const resolve = pendingReaderResolve;
        pendingReaderResolve = null;
        resolve(item);
      } else {
        if (queue.length >= 100) {
          observerDetached = true;
          queue.length = 0;
          return;
        }
        queue.push(item);
      }
    }

    // 1. Autonomous Backend Collector (The Pump)
    (async () => {
      let accumulatedText = '';

      try {
        for await (const chunk of dispatchResult.stream) {
          accumulatedText += chunk;
          pushToObserver({ type: 'chunk', value: chunk });
        }
        pushToObserver({ type: 'done' });
      } catch (streamErr) {
        pushToObserver({ type: 'error', error: streamErr });
      } finally {
        try {
          const metrics = await dispatchResult.completed;

          let artifact: NodeArtifact | undefined;
          if (!metrics.error && accumulatedText.length > 0) {
            artifact = {
              id: crypto.randomUUID(),
              rawOutput: accumulatedText,
              committedOutput: accumulatedText,
              isEdited: false,
              committedAt: new Date().toISOString(),
            };
          }

          resolveCompletion({
            artifact,
            metrics,
          });
        } catch (fatalErr) {
          rejectCompletion(fatalErr);
        }
      }
    })();

    // 2. Observer Tap Generator (Lazy)
    async function* createObserverStream(): AsyncIterable<string> {
      observerAttached = true;

      try {
        while (true) {
          const item: QueueItem = queue.length > 0
            ? queue.shift()!
            : await new Promise<QueueItem>((resolve) => {
                pendingReaderResolve = resolve;
              });

          if (item.type === 'chunk') {
            yield item.value;
          } else if (item.type === 'done') {
            break;
          } else if (item.type === 'error') {
            throw item.error;
          }
        }
      } finally {
        observerDetached = true;
        pendingReaderResolve = null;
        queue.length = 0;
      }
    }

    return {
      tokenStream: createObserverStream(),
      completion: completionPromise,
    };
  }
}
