import type { ChatProvider, ChatRequest, ProviderEvent } from "./types.js";

export class StubChatProvider implements ChatProvider {
  async *streamChat(_request: ChatRequest): AsyncIterable<ProviderEvent> {
    for (const token of ["Hello", "from", "the", "stub", "provider."]) {
      yield { type: "text.delta", text: `${token} ` };
    }

    yield {
      type: "tool_call",
      id: "stub-tool-1",
      name: "read_file",
      argumentsJson: JSON.stringify({ path: "README.md" }),
    };
    yield { type: "usage", promptTokens: 8, completionTokens: 5, totalTokens: 13 };
    yield { type: "finish", reason: "tool_calls" };
  }
}
