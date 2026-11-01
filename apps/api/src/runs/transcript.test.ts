import { expect, it } from "vitest";
import type { RunEvent } from "@vektor/shared";
import { compactTranscript } from "./transcript.js";
it("coalesces token deltas while preserving every text/tool boundary", () => {
  const events: RunEvent[] = [
    { runId: "run", seq: 1, type: "message.delta", text: "Before " },
    { runId: "run", seq: 2, type: "message.delta", text: "tool." },
    {
      runId: "run",
      seq: 3,
      type: "tool.requested",
      toolCallId: "tool",
      name: "browser",
      input: {},
    },
    {
      runId: "run",
      seq: 4,
      type: "tool.output",
      toolCallId: "tool",
      output: "Done",
      isError: false,
    },
    { runId: "run", seq: 5, type: "message.delta", text: "After." },
  ];
  expect(
    compactTranscript(
      events.map((event) => ({ type: event.type, payloadJson: JSON.stringify(event) })),
    ),
  ).toEqual([{ ...events[0], text: "Before tool." }, events[2], events[4]]);
});

it("preserves thinking separately from answer text in the saved transcript", () => {
  const events: RunEvent[] = [
    { runId: "run", seq: 1, type: "reasoning.delta", text: "Consider " },
    { runId: "run", seq: 2, type: "reasoning.delta", text: "the options." },
    { runId: "run", seq: 3, type: "message.delta", text: "Here is the answer." },
  ];
  expect(
    compactTranscript(
      events.map((event) => ({ type: event.type, payloadJson: JSON.stringify(event) })),
    ),
  ).toEqual([{ ...events[0], text: "Consider the options." }, events[2]]);
});
