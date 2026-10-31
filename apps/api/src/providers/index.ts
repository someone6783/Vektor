import { OpenRouterProvider } from "./openrouter-provider.js";
import { StubChatProvider } from "./stub.js";
import type { ChatProvider } from "./types.js";

export interface CreateChatProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export function createChatProvider(options: CreateChatProviderOptions): ChatProvider {
  if (!options.apiKey) {
    return new StubChatProvider();
  }

  return new OpenRouterProvider({
    apiKey: options.apiKey,
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
}

export * from "./types.js";
export { StubChatProvider } from "./stub.js";
export { OpenRouterProvider } from "./openrouter-provider.js";
export { normalizeOpenRouterStream } from "./openrouter.js";
