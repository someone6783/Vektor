import { expect, it } from "vitest";
import { applyRunEvent, startLiveRun } from "./live";

it("shows thinking between calls and tracks each call's result independently", () => {
  let live = startLiveRun("run");
  expect(live.phase).toBe("thinking");
  live = applyRunEvent(live, { runId: "run", seq: 1, type: "message.delta", text: "Opening page" });
  expect(live.phase).toBe("responding");
  live = applyRunEvent(live, {
    runId: "run",
    seq: 2,
    type: "tool.requested",
    toolCallId: "one",
    name: "browser.navigate",
    input: { url: "https://example.com" },
  });
  live = applyRunEvent(live, {
    runId: "run",
    seq: 3,
    type: "tool.requested",
    toolCallId: "two",
    name: "browser.snapshot",
    input: {},
  });
  expect(live.phase).toBe("tools");
  live = applyRunEvent(live, {
    runId: "run",
    seq: 4,
    type: "approval.requested",
    toolCallId: "one",
    approvalId: "approval",
    command: "Navigate",
  });
  expect(live.tools[0]?.status).toBe("waiting");
  live = applyRunEvent(live, {
    runId: "run",
    seq: 5,
    type: "tool.output",
    toolCallId: "one",
    output: "Loaded",
    isError: false,
  });
  expect(live.phase).toBe("tools");
  expect(live.tools[0]).toMatchObject({ status: "completed", output: "Loaded" });
  live = applyRunEvent(live, {
    runId: "run",
    seq: 6,
    type: "tool.output",
    toolCallId: "two",
    output: "Closed",
    isError: true,
  });
  expect(live.phase).toBe("thinking");
  expect(live.tools[1]).toMatchObject({ status: "failed", output: "Closed" });
  expect(live.text).toBe("Opening page");
});

it("keeps text and tool blocks in event order instead of concatenating separate model replies", () => {
  let live = startLiveRun("run");
  live = applyRunEvent(live, {
    runId: "run",
    seq: 1,
    type: "message.delta",
    text: "Navigating now.",
  });
  live = applyRunEvent(live, {
    runId: "run",
    seq: 2,
    type: "tool.requested",
    toolCallId: "tool",
    name: "browser",
    input: {},
  });
  live = applyRunEvent(live, {
    runId: "run",
    seq: 3,
    type: "tool.output",
    toolCallId: "tool",
    output: "Done",
    isError: false,
  });
  live = applyRunEvent(live, { runId: "run", seq: 4, type: "message.delta", text: "Found " });
  live = applyRunEvent(live, { runId: "run", seq: 5, type: "message.delta", text: "it." });
  expect(live.blocks).toEqual([
    { type: "text", id: "text-1", text: "Navigating now." },
    { type: "tool", id: "tool" },
    { type: "text", id: "text-4", text: "Found it." },
  ]);
});

it("keeps current context separate from cumulative usage, including after compaction", () => {
  let live = startLiveRun("run");
  live = applyRunEvent(live, {
    type: "usage",
    runId: "run",
    seq: 1,
    promptTokens: 20000,
    completionTokens: 300,
    totalTokens: 20300,
  });
  live = applyRunEvent(live, {
    type: "context.updated",
    runId: "run",
    seq: 2,
    context: { inputTokens: 10000, outputTokens: 100, totalTokens: 10100, contextWindow: 272000 },
  });
  live = applyRunEvent(live, {
    type: "context.updated",
    runId: "run",
    seq: 3,
    context: { inputTokens: 2000, outputTokens: 10, totalTokens: 2010, contextWindow: 272000 },
  });
  expect(live.context?.totalTokens).toBe(2010);
  expect(live.usage?.totalTokens).toBe(20300);
});
