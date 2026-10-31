import { describe, expect, it, vi } from "vitest";
import { OpenRouterProvider } from "./openrouter-provider.js";
import type { ChatMessage } from "./types.js";

describe("OpenRouter request contracts", () => {
  it("sends image content and the output allowance used by the context budget", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          'data: {"choices":[{"delta":{"content":"Seen"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        ),
      );
    const provider = new OpenRouterProvider({ apiKey: "fake-test-key", fetchImpl });
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "Describe" },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,example", detail: "auto" },
          },
        ],
      },
    ];
    const events = [];
    for await (const event of provider.streamChat({
      model: "vision",
      messages,
      maxTokens: 512,
      temperature: 0.2,
    }))
      events.push(event);
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({ messages, max_tokens: 512, temperature: 0.2, stream: true });
    expect(events.at(-1)).toEqual({ type: "finish", reason: "stop" });
  });

  it("retains context windows and image support from model metadata", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        data: [
          {
            id: "vision",
            name: "Vision",
            context_length: 32000,
            architecture: { input_modalities: ["text", "image"] },
          },
          { id: "text", context_length: 8000, architecture: { input_modalities: ["text"] } },
        ],
      }),
    );
    const provider = new OpenRouterProvider({ apiKey: "fake-test-key", fetchImpl });
    expect(await provider.listModels()).toEqual([
      { id: "text", name: "text", contextLength: 8000, supportsImages: false },
      { id: "vision", name: "Vision", contextLength: 32000, supportsImages: true },
    ]);
  });
});
