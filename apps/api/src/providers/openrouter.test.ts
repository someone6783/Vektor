import { describe, expect, it } from "vitest";
import {
  midStreamDisconnectFixture,
  providerErrorFixture,
  splitToolCallFixture,
  textOnlyFixture,
  usageFixture,
} from "./fixtures.js";
import { normalizeOpenRouterStream } from "./openrouter.js";
import type { ProviderEvent } from "./types.js";

async function collect(parts: string[]): Promise<ProviderEvent[]> {
  async function* chunks() {
    for (const part of parts) {
      yield part;
    }
  }

  const events: ProviderEvent[] = [];
  for await (const event of normalizeOpenRouterStream(chunks())) {
    events.push(event);
  }
  return events;
}

describe("OpenRouter normalizer", () => {
  it("normalizes text deltas, usage, and finish", async () => {
    const events = await collect(textOnlyFixture);

    expect(events).toEqual([
      { type: "text.delta", text: "Hello" },
      { type: "text.delta", text: " world" },
      {
        type: "usage",
        promptTokens: 6,
        completionTokens: 2,
        totalTokens: 8,
      },
      { type: "finish", reason: "stop" },
    ]);
  });

  it("assembles a tool call split across chunks", async () => {
    const events = await collect(splitToolCallFixture);

    expect(events).toEqual([
      {
        type: "tool_call",
        id: "call_1",
        name: "read_file",
        argumentsJson: '{"path":"README.md"}',
      },
      { type: "finish", reason: "tool_calls" },
    ]);
  });

  it("carries cost when the provider reports it", async () => {
    const events = await collect(usageFixture);

    expect(events).toEqual([
      { type: "text.delta", text: "Hi" },
      {
        type: "usage",
        promptTokens: 3,
        completionTokens: 1,
        totalTokens: 4,
        costUsd: 0.00002,
      },
      { type: "finish", reason: "stop" },
    ]);
  });

  it("turns provider errors into an error and an error finish", async () => {
    const events = await collect(providerErrorFixture);

    expect(events).toEqual([
      { type: "error", message: "Rate limit exceeded" },
      { type: "finish", reason: "error" },
    ]);
  });

  it("reports a mid-stream disconnect", async () => {
    const events = await collect(midStreamDisconnectFixture);

    expect(events).toEqual([
      { type: "text.delta", text: "This will be cut" },
      { type: "error", message: "Provider stream ended before completion." },
      { type: "finish", reason: "error" },
    ]);
  });

  it("handles frames split across transport chunks", async () => {
    const full = textOnlyFixture.join("");
    const splitAt = Math.floor(full.length / 3);
    const events = await collect([full.slice(0, splitAt), full.slice(splitAt)]);

    expect(events.at(-1)).toEqual({ type: "finish", reason: "stop" });
    expect(events.filter((event) => event.type === "text.delta")).toHaveLength(2);
  });
});

it("normalizes reasoning without duplicate structured copies or encrypted details", async () => {
  const events = await collect([
    `data: ${JSON.stringify({ choices: [{ delta: { reasoning: "First thought. ", reasoning_details: [{ type: "reasoning.text", text: "First thought. " }] } }] })}\n\n`,
    `data: ${JSON.stringify({
      choices: [
        {
          delta: {
            reasoning_details: [
              { type: "reasoning.summary", summary: "Summary. " },
              { type: "reasoning.text", text: "Next thought." },
              { type: "reasoning.encrypted", data: "private-signature" },
            ],
          },
        },
      ],
    })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: "Answer" }, finish_reason: "stop" }] })}\n\n`,
    "data: [DONE]\n\n",
  ]);
  expect(events.filter((event) => event.type !== "reasoning.details")).toEqual([
    { type: "reasoning.delta", text: "First thought. " },
    { type: "reasoning.delta", text: "Summary. Next thought." },
    { type: "text.delta", text: "Answer" },
    { type: "finish", reason: "stop" },
  ]);
});
