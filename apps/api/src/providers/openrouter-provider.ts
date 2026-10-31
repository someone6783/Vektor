import { normalizeOpenRouterStream } from "./openrouter.js";
import type { ChatProvider, ChatRequest, ProviderEvent } from "./types.js";

export interface OpenRouterProviderOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

async function* readBody(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      yield decoder.decode(value, { stream: true });
    }
    yield decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

export class OpenRouterProvider implements ChatProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenRouterProviderOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async *streamChat(request: ChatRequest): AsyncIterable<ProviderEvent> {
    let response: Response;

    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "http://localhost:8787",
          "X-Title": "Vektor",
        },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          stream: true,
          usage: { include: true },
        }),
        signal: request.signal,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }

      yield {
        type: "error",
        message: error instanceof Error ? error.message : "Provider request failed.",
      };
      yield { type: "finish", reason: "error" };
      return;
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      yield {
        type: "error",
        message: `OpenRouter returned ${response.status}${body ? `: ${body.slice(0, 500)}` : ""}`,
      };
      yield { type: "finish", reason: "error" };
      return;
    }

    if (!response.body) {
      yield { type: "error", message: "OpenRouter returned an empty body." };
      yield { type: "finish", reason: "error" };
      return;
    }

    yield* normalizeOpenRouterStream(readBody(response.body));
  }
}
