import type { ModelInfo } from "@vektor/shared";

export interface ChatMessage {
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  role: "system" | "user" | "assistant" | "tool";
  content:
    | string
    | Array<
        | { type: "text"; text: string }
        | { type: "image_url"; image_url: { url: string; detail: "auto" } }
      >;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  signal?: AbortSignal;
  maxTokens?: number;
  temperature?: number;
  tools?: Array<{
    type: "function";
    function: { name: string; description: string; parameters: Record<string, unknown> };
  }>;
}

export type ProviderEvent =
  | { type: "text.delta"; text: string }
  | { type: "tool_call"; id: string; name: string; argumentsJson: string }
  | {
      type: "usage";
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      costUsd?: number;
    }
  | { type: "error"; message: string }
  | { type: "finish"; reason: "stop" | "tool_calls" | "length" | "error" };

export interface ChatProvider {
  streamChat(request: ChatRequest): AsyncIterable<ProviderEvent>;
  listModels?(): Promise<ModelInfo[]>;
}
