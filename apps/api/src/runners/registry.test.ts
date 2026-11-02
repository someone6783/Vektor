import { describe, expect, it } from "vitest";
import { runnerDescriptorSchema } from "@vektor/shared";
import { assertRunnerAvailable, runnerAdapter } from "./registry.js";

describe("runner admission contract v1", () => {
  it("reports the native runner as available", () => {
    expect(runnerDescriptorSchema.parse(runnerAdapter("native").descriptor)).toEqual({
      contractVersion: 1,
      id: "native",
      available: true,
      reason: null,
    });
    expect(() => assertRunnerAvailable("native")).not.toThrow();
  });
  it.each(["codex", "cli", "acp:codex"])("rejects %s without fallback", (id) => {
    expect(runnerAdapter(id).descriptor.available).toBe(false);
    expect(() => assertRunnerAvailable(id)).toThrow();
  });
  it.each([undefined, "garbage", "acp:"])("fails closed on invalid persisted identity %s", (id) => {
    expect(() => assertRunnerAvailable(id)).toThrow("Unsupported runner identity.");
  });
});
