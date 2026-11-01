import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  createChannel,
  createMessage,
  createRun,
  getBrowserArtifact,
  listBrowserArtifacts,
  listProfiles,
  saveBrowserArtifact,
} from "@vektor/db";
import { bootstrapStorage } from "../bootstrap.js";
import { loadConfig } from "../config.js";

it("bounds screenshot storage and expires artifacts without exposing their bytes in metadata", () => {
  const directory = mkdtempSync(join(tmpdir(), "vektor-browser-artifact-"));
  const storage = bootstrapStorage(loadConfig({ NODE_ENV: "test", VEKTOR_DATA_DIR: directory }));
  try {
    const profile = listProfiles(storage.db)[0]!;
    const channel = createChannel(storage.db, { name: "Artifact", profileId: profile.id });
    const message = createMessage(storage.db, {
      channelId: channel.id,
      role: "user",
      content: "fixture",
    });
    const run = createRun(storage.db, {
      channelId: channel.id,
      profileId: profile.id,
      userMessageId: message.id,
      model: "test",
    });
    expect(
      saveBrowserArtifact(
        storage.db,
        run.id,
        "https://example.com",
        Buffer.alloc(1024 * 1024 + 1),
        1000,
      ),
    ).toBeNull();
    const id = saveBrowserArtifact(
      storage.db,
      run.id,
      "https://example.com",
      Buffer.from("jpeg bytes"),
      1000,
    )!;
    expect(listBrowserArtifacts(storage.db, run.id)[0]).not.toHaveProperty("jpeg");
    expect(getBrowserArtifact(storage.db, id)?.jpeg).toBe(
      Buffer.from("jpeg bytes").toString("base64"),
    );
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 1001);
    expect(getBrowserArtifact(storage.db, id)).toBeUndefined();
    expect(listBrowserArtifacts(storage.db, run.id)).toHaveLength(0);
  } finally {
    vi.restoreAllMocks();
    storage.sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
