export type ModelProvider = 'anthropic' | 'google' | 'openai';

export interface ModelTarget {
  readonly provider: ModelProvider;
  readonly modelId: string;
  readonly parameters: Readonly<{
    temperature?: number;
    topP?: number;
    maxOutputTokens?: number;
    stopSequences?: readonly string[];
  }>;
}

export interface EnvelopeDirectives {
  readonly roleProfile: string;
  readonly activeGoggle: string;
  readonly activeLens: string;
  readonly systemInstructions?: string;
}

export interface UpstreamReference {
  readonly sourceNodeId: string;
  readonly edgeLabel: string;
  readonly artifactSnapshotId: string;
}

export interface EnvelopeInput {
  readonly primaryText: string;
  readonly lineage: readonly UpstreamReference[];
  readonly contextAttachments?: readonly Readonly<{
    name: string;
    mimeType: string;
    content: string;
  }>[];
}

export type ExecutionFinishReason =
  | 'completed'
  | 'length_exceeded'
  | 'content_filter'
  | 'error'
  | 'aborted'
  | 'unknown';

export type ExecutionErrorCategory =
  | 'transient'
  | 'capacity'
  | 'context_overflow'
  | 'guardrail_trip'
  | 'invalid_parameters'
  | 'protocol_violation'
  | 'client_aborted';

export interface ExecutionErrorDetail {
  readonly category: ExecutionErrorCategory;
  readonly message: string;
  readonly code: string;
  readonly failedAtMs: number;
  readonly retryable: boolean;
  readonly diagnostics?: Readonly<Record<string, unknown>>;
}

export interface ExecutionMetrics {
  readonly latencyMs: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly finishReason: ExecutionFinishReason;
  readonly error?: ExecutionErrorDetail;
  readonly rawProviderRequestId?: string;
}

export interface NodeArtifact {
  readonly id: string;
  readonly rawOutput: string;
  readonly committedOutput: string;
  readonly isEdited: boolean;
  readonly committedAt: string;
}

export interface PromptEnvelopeDTO {
  readonly envelopeVersion: '1.0.0';
  readonly envelopeId: string;
  readonly nodeId: string;
  readonly threadId: string;
  readonly target: ModelTarget;
  readonly directives: EnvelopeDirectives;
  readonly input: EnvelopeInput;
  readonly artifact?: NodeArtifact;
  readonly metrics?: ExecutionMetrics;
  readonly createdAt: string;
}

export interface RawTransportHeaders {
  readonly [key: string]: string | string[] | undefined;
}

export interface RawExecutionResult {
  readonly response?: any;
  readonly error?: unknown;
  readonly headers?: RawTransportHeaders;
  /** Whether the caller's AbortSignal had fired when the error was caught. */
  readonly aborted?: boolean;
}

export interface DispatchedExecution {
  readonly stream: AsyncIterable<string>;
  readonly completed: Promise<ExecutionMetrics>;
}

export interface IModelProviderAdapter {
  readonly provider: ModelProvider;
  dispatch(envelope: PromptEnvelopeDTO, abortSignal?: AbortSignal): DispatchedExecution;
  normalizeExecution(rawResult: RawExecutionResult, elapsedMs: number): ExecutionMetrics;
}
