import { normalizeOpenRouterStream } from "./openrouter.js";
import type { ChatProvider, ChatRequest, ProviderEvent } from "./types.js";
import type { ModelInfo } from "@vektor/shared";

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

  async listModels(): Promise<ModelInfo[]> {
    const response = await this.fetchImpl(`${this.baseUrl}/models`, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "HTTP-Referer": "http://localhost:8787",
        "X-Title": "Vektor",
      },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `OpenRouter returned ${response.status}${body ? `: ${body.slice(0, 500)}` : ""}`,
      );
    }

    const payload = (await response.json()) as {
      data?: Array<{ id?: string; name?: string; context_length?: number }>;
    };

    return (payload.data ?? [])
      .filter(
        (model): model is { id: string; name?: string; context_length?: number } =>
          typeof model.id === "string" && model.id.length > 0,
      )
      .map((model) => ({
        id: model.id,
        name: model.name ?? model.id,
        ...(typeof model.context_length === "number" && model.context_length > 0
          ? { contextLength: model.context_length }
          : {}),
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
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
