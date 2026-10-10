import { ModelProvider, IModelProviderAdapter } from './types.js';
import { AnthropicProviderAdapter } from './anthropic-adapter.js';
import { OpenAIProviderAdapter } from './openai-adapter.js';
import { GeminiProviderAdapter } from './gemini-adapter.js';

export interface ProviderClients {
  readonly anthropic?: any;
  readonly google?: any;
  readonly openai?: any;
}

export class UnregisteredProviderError extends Error {
  readonly code = 'UNREGISTERED_PROVIDER_ACTUATOR';
  constructor(message: string) {
    super(message);
    this.name = 'UnregisteredProviderError';
  }
}

export class ProviderAdapterFactory {
  private readonly registry = new Map<ModelProvider, IModelProviderAdapter>();

  constructor(clients: ProviderClients) {
    if (clients.anthropic) {
      this.registry.set('anthropic', new AnthropicProviderAdapter(clients.anthropic));
    }
    if (clients.google) {
      this.registry.set('google', new GeminiProviderAdapter(clients.google));
    }
    if (clients.openai) {
      this.registry.set('openai', new OpenAIProviderAdapter(clients.openai));
    }
  }

  getAdapter(provider: ModelProvider): IModelProviderAdapter {
    const adapter = this.registry.get(provider);
    if (!adapter) {
      throw new UnregisteredProviderError(
        `No active actuator adapter registered for provider key: '${provider}'. ` +
        `Verify server-side credentials and adapter bindings.`
      );
    }
    return adapter;
  }

  isRegistered(provider: ModelProvider): boolean {
    return this.registry.has(provider);
  }
}
