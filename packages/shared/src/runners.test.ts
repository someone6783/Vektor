import { describe, expect, it } from "vitest";
import { runnerIdSchema } from "./runners.js";
import { runStartedEventSchema } from "./run-events.js";
import { createProfileSchema, sendMessageSchema, updateProfileSchema } from "./workspace.js";

describe("runner identities", () => {
  it.each(["native", "cli", "codex", "acp:codex", "acp:agent-1.2"])(
    "accepts %s across requests and events",
    (runner) => {
      expect(createProfileSchema.parse({ name: "Agent", model: "model", runner }).runner).toBe(
        runner,
      );
      expect(updateProfileSchema.parse({ runner }).runner).toBe(runner);
      expect(sendMessageSchema.parse({ content: "Hello", runner }).runner).toBe(runner);
      expect(
        runStartedEventSchema.parse({
          seq: 1,
          runId: "r",
          type: "run.started",
          conversationId: null,
          profileId: null,
          runner,
        }).runner,
      ).toBe(runner);
    },
  );
  it.each([
    "acp",
    "acp:",
    "acp:../agent",
    "acp:agent/name",
    "acp:Agent",
    "unknown",
    `acp:${"a".repeat(101)}`,
  ])("rejects malformed identity %s", (runner) => {
    expect(runnerIdSchema.safeParse(runner).success).toBe(false);
  });
});
