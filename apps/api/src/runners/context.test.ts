import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { openDatabase, runMigrations, setSetting } from "@vektor/db";
import { codexContext, knownContextWindow, rememberContextWindow } from "./context.js";
let clean = () => {};
afterEach(() => clean());
it("uses the latest Codex request rather than cumulative billable tokens", () => {
  expect(
    codexContext({
      tokenUsage: {
        total: { inputTokens: 20000, outputTokens: 300, totalTokens: 20300 },
        last: { inputTokens: 2000, outputTokens: 10, totalTokens: 2010 },
        modelContextWindow: 272000,
      },
    }),
  ).toEqual({ inputTokens: 2000, outputTokens: 10, totalTokens: 2010, contextWindow: 272000 });
});
it("keeps a missing context window unknown and never substitutes cumulative usage", () => {
  expect(
    codexContext({
      tokenUsage: {
        last: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
        modelContextWindow: null,
      },
    })?.contextWindow,
  ).toBeNull();
  expect(
    codexContext({
      tokenUsage: { total: { inputTokens: 500, outputTokens: 100, totalTokens: 600 } },
    }),
  ).toBeUndefined();
  expect(
    codexContext({ tokenUsage: { last: { inputTokens: -1, outputTokens: 1, totalTokens: 0 } } }),
  ).toBeUndefined();
});
it("learns limits per model and invalidates them after account or executable changes", () => {
  const dir = mkdtempSync(join(tmpdir(), "vektor-context-window-"));
  const { db, sqlite } = openDatabase(join(dir, "db"));
  clean = () => {
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  };
  runMigrations(db);
  setSetting(db, "runner.installations", [{ id: "codex", executableHash: "verified" }]);
  const context = { inputTokens: 5, outputTokens: 1, totalTokens: 6, contextWindow: 272000 };
  expect(knownContextWindow(db, "codex", "model-a")).toBeNull();
  rememberContextWindow(db, "codex", "model-a", "verified", context);
  expect(knownContextWindow(db, "codex", "model-a")).toBe(272000);
  expect(knownContextWindow(db, "codex", "model-b")).toBeNull();
  setSetting(db, "runner.authVersion.codex", 1);
  expect(knownContextWindow(db, "codex", "model-a")).toBeNull();
  rememberContextWindow(db, "codex", "model-a", "verified", context);
  setSetting(db, "runner.installations", [{ id: "codex", executableHash: "updated" }]);
  expect(knownContextWindow(db, "codex", "model-a")).toBeNull();
});
