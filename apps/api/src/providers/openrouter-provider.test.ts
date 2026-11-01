import { describe, expect, it } from "vitest";
import { OpenRouterProvider } from "./openrouter-provider.js";
import type { ProviderEvent } from "./types.js";

const apiKey = process.env.VEKTOR_OPENROUTER_KEY;
const model = process.env.VEKTOR_OPENROUTER_MODEL ?? "openrouter/auto";

describe.skipIf(!apiKey)("OpenRouter live provider", () => {
  it("streams a short reply", async () => {
    const provider = new OpenRouterProvider({ apiKey: apiKey! });
    const events: ProviderEvent[] = [];

    for await (const event of provider.streamChat({
      model,
      messages: [{ role: "user", content: "Reply with exactly: ok" }],
    })) {
      events.push(event);
    }

    expect(events.some((event) => event.type === "text.delta")).toBe(true);
    expect(events.at(-1)?.type).toBe("finish");
  }, 30_000);
});

describe("OpenRouter reasoning controls", () => {
  it("loads the model's supported reasoning choices", async () => {
    const provider = new OpenRouterProvider({
      apiKey: "test",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: "model",
                reasoning: { supported_efforts: ["low", "high"], mandatory: true },
                supported_parameters: ["reasoning"],
              },
              { id: "plain", supported_parameters: ["temperature"] },
            ],
          }),
          { status: 200 },
        ),
    });
    const models = await provider.listModels();
    expect(models[0]).toMatchObject({
      id: "model",
      supportsReasoning: true,
      reasoningMandatory: true,
      reasoningEfforts: ["low", "high"],
    });
    expect(models[1]).toMatchObject({ id: "plain", supportsReasoning: false });
  });
  it("sends the selected reasoning configuration while leaving Auto to the provider", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const provider = new OpenRouterProvider({
      apiKey: "test",
      fetchImpl: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(
          'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        );
      },
    });
    for (const reasoning of ["auto", "on", "none", "high"] as const) {
      for await (const _event of provider.streamChat({ model: "model", messages: [], reasoning })) {
        /* Drain the stream. */
      }
    }
    expect(bodies.map((body) => body.reasoning)).toEqual([
      undefined,
      { enabled: true, exclude: false },
      { enabled: false },
      { effort: "high", exclude: false },
    ]);
  });
});
