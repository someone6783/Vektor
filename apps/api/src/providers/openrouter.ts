import type { ProviderEvent } from "./types.js";

interface OpenRouterChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cost?: number;
  };
  error?: {
    message?: string;
  };
}

type FinishReason = "stop" | "tool_calls" | "length" | "error";

function toFinishReason(value: string | null | undefined): FinishReason | undefined {
  if (value === "stop" || value === "tool_calls" || value === "length") {
    return value;
  }
  if (value === "error") {
    return "error";
  }
  return undefined;
}

export async function* normalizeOpenRouterStream(
  chunks: AsyncIterable<string>,
): AsyncIterable<ProviderEvent> {
  let buffer = "";
  let done = false;
  let finishReason: FinishReason | undefined;
  let usage: Extract<ProviderEvent, { type: "usage" }> | undefined;
  let streamError: string | undefined;
  const toolCalls = new Map<number, { id: string; name: string; argumentsJson: string }>();

  const processLine = (rawLine: string): ProviderEvent[] => {
    const line = rawLine.replace(/\r$/, "").trim();

    if (line === "" || line.startsWith(":") || !line.startsWith("data:")) {
      return [];
    }

    const data = line.slice("data:".length).trim();

    if (data === "[DONE]") {
      done = true;
      return [];
    }

    let parsed: OpenRouterChunk;

    try {
      parsed = JSON.parse(data) as OpenRouterChunk;
    } catch {
      return [{ type: "error", message: "Provider sent invalid JSON." }];
    }

    if (parsed.error) {
      streamError = parsed.error.message ?? "Provider returned an error.";
      return [];
    }

    const events: ProviderEvent[] = [];
    const choice = parsed.choices?.[0];
    const text = choice?.delta?.content;

    if (typeof text === "string" && text.length > 0) {
      events.push({ type: "text.delta", text });
    }

    for (const call of choice?.delta?.tool_calls ?? []) {
      const index = call.index ?? 0;
      const current = toolCalls.get(index) ?? { id: "", name: "", argumentsJson: "" };

      if (call.id) {
        current.id = call.id;
      }
      if (call.function?.name) {
        current.name += call.function.name;
      }
      if (call.function?.arguments) {
        current.argumentsJson += call.function.arguments;
      }

      toolCalls.set(index, current);
    }

    const reason = toFinishReason(choice?.finish_reason);
    if (reason) {
      finishReason = reason;
    }

    if (parsed.usage) {
      const promptTokens = parsed.usage.prompt_tokens ?? 0;
      const completionTokens = parsed.usage.completion_tokens ?? 0;
      usage = {
        type: "usage",
        promptTokens,
        completionTokens,
        totalTokens: parsed.usage.total_tokens ?? promptTokens + completionTokens,
        ...(typeof parsed.usage.cost === "number" ? { costUsd: parsed.usage.cost } : {}),
      };
    }

    return events;
  };

  for await (const chunk of chunks) {
    buffer += chunk;

    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);

      for (const event of processLine(line)) {
        yield event;
      }

      newline = buffer.indexOf("\n");
    }
  }

  if (buffer.trim() !== "") {
    for (const event of processLine(buffer)) {
      yield event;
    }
  }

  if (streamError) {
    yield { type: "error", message: streamError };
    yield { type: "finish", reason: "error" };
    return;
  }

  if (!done && !finishReason) {
    yield { type: "error", message: "Provider stream ended before completion." };
    yield { type: "finish", reason: "error" };
    return;
  }

  const orderedCalls = [...toolCalls.entries()].sort(([left], [right]) => left - right);

  for (const [index, call] of orderedCalls) {
    yield {
      type: "tool_call",
      id: call.id || `tool-${index}`,
      name: call.name || "unknown_tool",
      argumentsJson: call.argumentsJson || "{}",
    };
  }

  if (usage) {
    yield usage;
  }

  yield {
    type: "finish",
    reason: finishReason ?? (toolCalls.size > 0 ? "tool_calls" : "stop"),
  };
}
