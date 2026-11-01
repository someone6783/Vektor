import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getSetting, setSetting } from "@vektor/db";
import { browserPermissionsSchema } from "@vektor/shared";
import { bootstrapStorage, type Storage } from "../bootstrap.js";
import { loadConfig } from "../config.js";
import { DefaultBrowserProfileStore } from "./profile.js";
import { BrowserService } from "./service.js";
import { AttachmentService } from "../attachments/service.js";
import type { BrowserSessionOptions, BrowserStorageState } from "./controller.js";

let directory: string;
let storage: Storage;
const a = browserPermissionsSchema.parse({
  mode: "interactive",
  session: "default",
  allowedOrigins: ["https://a.example"],
});
const b = browserPermissionsSchema.parse({
  mode: "observe",
  session: "default",
  allowedOrigins: ["https://b.example"],
});
const state = (host: string, value = "private-login-cookie"): BrowserStorageState => ({
  cookies: [
    {
      name: "login",
      value,
      domain: host,
      path: "/",
      expires: -1,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    },
  ],
  origins: [
    { origin: `https://${host}`, localStorage: [{ name: "pref", value: "saved-preference" }] },
  ],
});
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "vektor-profile-store-"));
  storage = bootstrapStorage(loadConfig({ NODE_ENV: "test", VEKTOR_DATA_DIR: directory }));
});
afterEach(() => {
  storage.sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("saved default browser profile", () => {
  it("encrypts profile state, reopens it and reveals only authorized origins", () => {
    const profile = new DefaultBrowserProfileStore(storage.db, storage.secretsKey);
    profile.save(state("a.example"), a);
    profile.save(state("b.example", "second-cookie"), b);
    expect(String(getSetting(storage.db, "browser.defaultProfile"))).not.toContain(
      "private-login-cookie",
    );
    const reopened = new DefaultBrowserProfileStore(storage.db, storage.secretsKey);
    expect(reopened.load(a)).toEqual(state("a.example"));
    expect(reopened.load(b)).toEqual(state("b.example", "second-cookie"));
    expect(JSON.stringify(reopened.info)).not.toContain("cookie");
    reopened.save({ cookies: [], origins: [] }, a);
    expect(reopened.load(a)).toEqual({ cookies: [], origins: [] });
    expect(reopened.load(b).cookies).toHaveLength(1);
    reopened.reset();
    expect(reopened.info.configured).toBe(false);
  });
  it("rejects corrupt or oversized state and preserves the previous saved profile", () => {
    const profile = new DefaultBrowserProfileStore(storage.db, storage.secretsKey);
    profile.save(state("a.example"), a);
    expect(() => profile.save(state("a.example", "x".repeat(4 * 1024 * 1024)), a)).toThrow(/limit/);
    expect(profile.load(a)).toEqual(state("a.example"));
    setSetting(storage.db, "browser.defaultProfile", "corrupt ciphertext");
    expect(() => profile.load(a)).toThrow(/Reset/);
  });
  it("keeps the default lock until closure finishes and never seeds separate sessions", async () => {
    let finishClose!: () => void;
    const started: BrowserSessionOptions[] = [];
    const service = new BrowserService({
      db: storage.db,
      secretsKey: storage.secretsKey,
      dataDir: directory,
      attachments: new AttachmentService(storage.db, directory),
      redact: (value) => value,
      factory: (options) => {
        const index = started.length;
        started.push(options);
        return {
          execute: async () => ({}),
          state: () => ({
            active: true,
            paused: false,
            sensitive: false,
            url: "about:blank",
            tabs: [],
            actions: 0,
            snapshot: "",
          }),
          pause: () => {},
          close: async () => {
            if (index === 0)
              await new Promise<void>((resolve) => {
                finishClose = resolve;
              });
            options.saveStorageState?.(state("a.example"));
          },
        };
      },
    });
    const options = {
      signal: new AbortController().signal,
      permissions: () => a,
      approve: async () => true,
    };
    await service.initialize();
    try {
      await service.execute("first", "channel", { action: "snapshot" }, options);
      const closing = service.close("first");
      const again = service.close("first");
      await expect(
        service.execute("second", "channel", { action: "snapshot" }, options),
      ).rejects.toThrow(/already in use/);
      finishClose();
      await Promise.all([closing, again]);
      await service.execute("second", "channel", { action: "snapshot" }, options);
      expect(started[1]?.storageState).toEqual(state("a.example"));
      await service.execute(
        "separate",
        "channel",
        { action: "snapshot" },
        { ...options, permissions: () => ({ ...a, session: "separate" }) },
      );
      expect(started[2]?.storageState).toBeUndefined();
      expect(started[2]?.saveStorageState).toBeUndefined();
    } finally {
      await service.stopAll();
    }
  });
  it("resets an active profile without saving stale state back and preserves separate sessions", async () => {
    const started: BrowserSessionOptions[] = [];
    const service = new BrowserService({
      db: storage.db,
      secretsKey: storage.secretsKey,
      dataDir: directory,
      attachments: new AttachmentService(storage.db, directory),
      redact: (value) => value,
      factory: (options) => {
        started.push(options);
        return {
          execute: async () => ({}),
          state: () => ({
            active: true,
            paused: false,
            sensitive: false,
            url: "about:blank",
            tabs: [],
            actions: 0,
            snapshot: "",
          }),
          pause: () => {},
          close: async () => {
            options.saveStorageState?.(state("a.example"));
          },
        };
      },
    });
    const options = {
      signal: new AbortController().signal,
      permissions: () => a,
      approve: async () => true,
    };
    await service.initialize();
    try {
      await service.execute("first", "channel", { action: "snapshot" }, options);
      await service.execute(
        "separate",
        "channel",
        { action: "snapshot" },
        { ...options, permissions: () => ({ ...a, session: "separate" }) },
      );
      await service.defaultProfileControl("reset");
      expect(service.defaultProfileInfo().configured).toBe(false);
      expect(service.state("separate").active).toBe(true);
      await expect(
        service.execute("first", "channel", { action: "snapshot" }, options),
      ).rejects.toThrow(/disconnected/);
      await service.execute("fresh", "channel", { action: "snapshot" }, options);
      expect(started[2]?.storageState).toEqual({ cookies: [], origins: [] });
    } finally {
      await service.stopAll();
    }
  });
});
