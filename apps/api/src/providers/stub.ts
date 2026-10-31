import type { ChatProvider, ChatRequest, ProviderEvent } from "./types.js";

const STUB_TEXT =
  "Here is a **streamed** response from the stub provider.\n\n" +
  "- The API persisted these events.\n" +
  "- Markdown renders in the workspace.\n\n" +
  '```ts\nconst status = "ok";\n```\n\n' +
  "Add an OpenRouter key in Settings for real answers. ";

function tokenize(text: string): string[] {
  return text.match(/\S+\s*/g) ?? [text];
}

export class StubChatProvider implements ChatProvider {
  async *streamChat(request: ChatRequest): AsyncIterable<ProviderEvent> {
    for (const token of tokenize(STUB_TEXT)) {
      if (request.signal?.aborted) {
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 10));
      yield { type: "text.delta", text: token };
    }

    if (request.signal?.aborted) {
      return;
    }

    const demoTool = request.tools?.some((tool) => tool.function.name === "read_file");
    if (demoTool)
      yield {
        type: "tool_call",
        id: "stub-tool-1",
        name: "read_file",
        argumentsJson: JSON.stringify({ path: "README.md" }),
      };
    yield { type: "usage", promptTokens: 8, completionTokens: 5, totalTokens: 13 };
    yield { type: "finish", reason: demoTool ? "tool_calls" : "stop" };
  }
}
