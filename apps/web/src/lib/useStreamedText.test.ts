import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { applyRunEvent, startLiveRun } from "./live";
import { completedParagraphs } from "./paragraphs";
import { useStreamedText } from "./useStreamedText";
import { setChunkedStreaming, useChunkedStreaming } from "./streamingPreference";

afterEach(() => {
  cleanup();
  localStorage.clear();
});
function text(value: string) {
  return applyRunEvent(startLiveRun("one"), {
    runId: "one",
    seq: 1,
    type: "message.delta",
    text: value,
  });
}
it("holds unfinished prose and reveals complete paragraphs instead of timed word batches", () => {
  expect(useStreamedText(text("Hello"), true)).toBe("");
  expect(useStreamedText(text("Hello world.\n\nNext para"), true)).toBe("Hello world.\n\n");
  expect(useStreamedText(text("Hello world.\n\nNext paragraph.\n\nTail"), true)).toBe(
    "Hello world.\n\nNext paragraph.\n\n",
  );
});
it("flushes incomplete text at a tool boundary and at every terminal status", () => {
  const live = text("Opening page");
  const tool = applyRunEvent(live, {
    runId: "one",
    seq: 2,
    type: "tool.requested",
    toolCallId: "tool",
    name: "browser",
    input: {},
  });
  expect(useStreamedText(tool, true)).toContain("Opening page");
  for (const status of ["completed", "cancelled", "failed"] as const) {
    expect(useStreamedText({ ...live, status }, true)).toBe("Opening page");
  }
  expect(useStreamedText(live, false)).toBe("Opening page");
  expect(useStreamedText(startLiveRun("two"), true)).toBe("");
});
it("does not reveal unfinished code at blank lines inside a fence", () => {
  expect(completedParagraphs("Intro.\n\n```js\nconst x = 1;\n\nconst y")).toBe("Intro.\n\n");
  expect(completedParagraphs("```js\nconst x = 1;\n```\nTail")).toBe("```js\nconst x = 1;\n```\n");
  expect(completedParagraphs("First.\r\n\r\nNext")).toBe("First.\r\n\r\n");
});
it("defaults to paragraph chunks and persists preference changes", () => {
  const { result } = renderHook(useChunkedStreaming);
  expect(result.current).toBe(true);
  act(() => setChunkedStreaming(false));
  expect(result.current).toBe(false);
  expect(localStorage.getItem("vektor.chunkedStreaming")).toBe("false");
});
