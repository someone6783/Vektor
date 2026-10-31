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
