export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  signal?: AbortSignal;
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
}
