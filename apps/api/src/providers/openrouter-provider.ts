import { normalizeOpenRouterStream } from "./openrouter.js";
import type { ChatProvider, ChatRequest, ProviderEvent } from "./types.js";
import { reasoningEffortSchema, type ModelInfo } from "@vektor/shared";

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
  readonly kind = "openrouter" as const;
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
      signal: AbortSignal.timeout(15_000),
      headers: {
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
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
      data?: Array<{
        id?: string;
        name?: string;
        context_length?: number;
        architecture?: { input_modalities?: string[] };
        supported_parameters?: string[];
        reasoning?: { supported_efforts?: string[] | null; mandatory?: boolean };
      }>;
    };

    return (payload.data ?? [])
      .filter(
        (
          model,
        ): model is {
          id: string;
          name?: string;
          context_length?: number;
          architecture?: { input_modalities?: string[] };
          supported_parameters?: string[];
          reasoning?: { supported_efforts?: string[] | null; mandatory?: boolean };
        } => typeof model.id === "string" && model.id.length > 0,
      )
      .map((model) => ({
        id: model.id,
        name: model.name ?? model.id,
        ...(model.reasoning || model.supported_parameters
          ? {
              supportsReasoning:
                !!model.reasoning || model.supported_parameters?.includes("reasoning") === true,
              reasoningMandatory: model.reasoning?.mandatory ?? false,
              ...(model.reasoning?.supported_efforts !== undefined
                ? {
                    reasoningEfforts: (
                      model.reasoning.supported_efforts ?? [
                        "none",
                        "minimal",
                        "low",
                        "medium",
                        "high",
                        "xhigh",
                        "max",
                      ]
                    ).filter(
                      (effort) => reasoningEffortSchema.safeParse(effort).success,
                    ) as ModelInfo["reasoningEfforts"],
                  }
                : {}),
            }
          : {}),
        ...(model.architecture?.input_modalities
          ? { supportsImages: model.architecture.input_modalities.includes("image") }
          : {}),
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
          ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
          usage: { include: true },
          ...(request.reasoning && request.reasoning !== "auto"
            ? {
                reasoning:
                  request.reasoning === "on"
                    ? { enabled: true, exclude: false }
                    : request.reasoning === "none"
                      ? { enabled: false }
                      : { effort: request.reasoning, exclude: false },
              }
            : {}),
          ...(request.tools?.length ? { tools: request.tools, tool_choice: "auto" } : {}),
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
