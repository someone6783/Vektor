import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  createChannel,
  createMessage,
  createRun,
  getComputerArtifact,
  listComputerArtifacts,
  listProfiles,
  saveComputerArtifact,
} from "@vektor/db";
import { bootstrapStorage } from "../bootstrap.js";
import { loadConfig } from "../config.js";

it("bounds screenshot storage and expires artifacts without exposing their bytes in metadata", () => {
  const directory = mkdtempSync(join(tmpdir(), "vektor-computer-artifact-"));
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
      saveComputerArtifact(
        storage.db,
        run.id,
        "action-id",
        "click",
        "before",
        Buffer.alloc(4 * 1024 * 1024 + 1),
        1000,
      ),
    ).toBeNull();
    const id = saveComputerArtifact(
      storage.db,
      run.id,
      "action-id",
      "click",
      "before",
      Buffer.from("jpeg bytes"),
      1000,
    )!;
    expect(listComputerArtifacts(storage.db, run.id)[0]).not.toHaveProperty("jpeg");
    expect(getComputerArtifact(storage.db, id)?.jpeg).toBe(
      Buffer.from("jpeg bytes").toString("base64"),
    );
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 1001);
    expect(getComputerArtifact(storage.db, id)).toBeUndefined();
    expect(listComputerArtifacts(storage.db, run.id)).toHaveLength(0);
  } finally {
    vi.restoreAllMocks();
    storage.sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
