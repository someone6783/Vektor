import { describe, expect, it } from "vitest";
import { createSseParser, type SseFrame } from "./sse";

describe("SSE parser", () => {
  it("parses frames that arrive in arbitrary chunks", () => {
    const frames: SseFrame[] = [];
    const parser = createSseParser((frame) => frames.push(frame));

    parser.push('id: 1\nevent: message.delta\ndata: {"text":"hel');
    parser.push('lo"}\n\nid: 2\nevent: run.completed\ndata: {"seq":2}\n\n');

    expect(frames).toEqual([
      { id: "1", event: "message.delta", data: '{"text":"hello"}' },
      { id: "2", event: "run.completed", data: '{"seq":2}' },
    ]);
  });

  it("ignores comments and supports multi-line data", () => {
    const frames: SseFrame[] = [];
    const parser = createSseParser((frame) => frames.push(frame));

    parser.push(": ping\n\n");
    parser.push("event: notice\ndata: line one\ndata: line two\n\n");

    expect(frames).toEqual([{ event: "notice", data: "line one\nline two" }]);
  });

  it("resets buffered partial frames", () => {
    const frames: SseFrame[] = [];
    const parser = createSseParser((frame) => frames.push(frame));

    parser.push("id: 3\ndata: partial");
    parser.reset();
    parser.push("id: 4\ndata: complete\n\n");

    expect(frames).toEqual([{ id: "4", data: "complete" }]);
  });
});
