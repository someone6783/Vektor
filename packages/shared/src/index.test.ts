import { describe, expect, it } from "vitest";
import {
  formatSseFrame,
  healthResponseSchema,
  parseStreamCursor,
  runEventSchema,
  RUN_EVENT_TYPES,
  type RunEvent,
} from "./index.js";

const samples: RunEvent[] = [
  {
    seq: 1,
    runId: "run-1",
    type: "run.started",
    conversationId: "conv-1",
    profileId: "profile-1",
    runner: "native",
  },
  { seq: 2, runId: "run-1", type: "message.delta", text: "Hello" },
  { seq: 2, runId: "run-1", type: "reasoning.delta", text: "A reasoning summary" },
  {
    seq: 3,
    runId: "run-1",
    type: "tool.requested",
    toolCallId: "tool-1",
    name: "read_file",
    input: { path: "README.md" },
  },
  {
    seq: 4,
    runId: "run-1",
    type: "tool.output",
    toolCallId: "tool-1",
    output: "contents",
    isError: false,
  },
  {
    seq: 4,
    runId: "run-1",
    type: "tool.progress",
    toolCallId: "tool-1",
    detail: { progress: 1, total: 2 },
  },
  {
    seq: 5,
    runId: "run-1",
    type: "approval.requested",
    approvalId: "approval-1",
    toolCallId: "tool-2",
    command: "rm -rf build",
  },
  {
    seq: 6,
    runId: "run-1",
    type: "usage",
    promptTokens: 12,
    completionTokens: 8,
    totalTokens: 20,
    costUsd: 0.0001,
  },
  { seq: 7, runId: "run-1", type: "run.completed", messageId: "message-1" },
  { seq: 8, runId: "run-1", type: "run.failed", error: "provider unavailable", code: "upstream" },
  { seq: 9, runId: "run-1", type: "run.cancelled", reason: "user" },
];

describe("run event contract", () => {
  it("accepts every event type", () => {
    expect(samples.map((event) => event.type)).toEqual([...RUN_EVENT_TYPES]);

    for (const sample of samples) {
      expect(runEventSchema.parse(sample)).toEqual(sample);
    }
  });

  it("rejects unknown event types", () => {
    expect(() =>
      runEventSchema.parse({ seq: 1, runId: "run-1", type: "message.unknown" }),
    ).toThrow();
  });

  it("rejects negative or fractional sequence numbers", () => {
    expect(() =>
      runEventSchema.parse({ seq: -1, runId: "run-1", type: "message.delta", text: "no" }),
    ).toThrow();
    expect(() =>
      runEventSchema.parse({ seq: 1.5, runId: "run-1", type: "message.delta", text: "no" }),
    ).toThrow();
  });

  it("formats an SSE frame that carries the full event", () => {
    const event = samples[1]!;
    const frame = formatSseFrame(event);

    expect(frame).toContain(`id: ${event.seq}`);
    expect(frame).toContain(`event: ${event.type}`);
    expect(frame.endsWith("\n\n")).toBe(true);

    const data = frame
      .split("\n")
      .find((line) => line.startsWith("data: "))
      ?.slice("data: ".length);

    expect(data).toBeDefined();
    expect(runEventSchema.parse(JSON.parse(data!))).toEqual(event);
  });
});

describe("stream cursor", () => {
  it("parses valid cursors and defaults invalid ones to zero", () => {
    expect(parseStreamCursor("12")).toBe(12);
    expect(parseStreamCursor(0)).toBe(0);
    expect(parseStreamCursor("-3")).toBe(0);
    expect(parseStreamCursor("abc")).toBe(0);
    expect(parseStreamCursor(undefined)).toBe(0);
  });
});

describe("health response contract", () => {
  it("parses a healthy and an unhealthy response", () => {
    const base = {
      version: "0.1.0",
      instanceId: "instance-1",
      uptimeSeconds: 12,
    };

    expect(healthResponseSchema.parse({ ...base, status: "ok", database: "ok" }).status).toBe("ok");
    expect(healthResponseSchema.parse({ ...base, status: "error", database: "error" }).status).toBe(
      "error",
    );
  });
});
