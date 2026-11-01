import { mkdtemp, readFile, writeFile, mkdir, readdir, rm, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createChannel,
  getSetting,
  listProfiles,
  setSetting,
  openReadOnlyDatabase,
} from "@vektor/db";
import { bootstrapStorage, type Storage } from "../bootstrap.js";
import { loadConfig } from "../config.js";
import { encryptSecret, decryptSecret } from "../secrets.js";
import { AttachmentService } from "../attachments/service.js";
import { createBackup, restoreBackup, verifyBackup } from "./backup.js";
import { acquireDataLock } from "./data-lock.js";
import { DefaultBrowserProfileStore } from "../browser/profile.js";
import { browserPermissionsSchema } from "@vektor/shared";

let root: string;
let dataDir: string;
let backup: string;
let storage: Storage | null;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "vektor-backup-"));
  dataDir = join(root, "data");
  backup = join(root, "backup");
  storage = bootstrapStorage(loadConfig({ NODE_ENV: "test", VEKTOR_DATA_DIR: dataDir }));
  const profile = listProfiles(storage.db)[0]!;
  const channel = createChannel(storage.db, { name: "Restorable", profileId: profile.id });
  await new AttachmentService(storage.db, dataDir).save(
    channel.id,
    "notes.txt",
    Buffer.from("Original attachment\n"),
  );
  setSetting(
    storage.db,
    "provider.openrouter.key",
    encryptSecret("synthetic-backup-provider-key", storage.secretsKey),
  );
  setSetting(storage.db, "scheduler.paused", true);
  setSetting(storage.db, "runtime.emergencyStopped", true);
  await writeFile(join(dataDir, "workspace", "script.sh"), "echo restored\n", { mode: 0o700 });
  await symlink("script.sh", join(dataDir, "workspace", "script-link"));
});
afterEach(async () => {
  storage?.sqlite.close();
  await rm(root, { recursive: true, force: true });
});
function close() {
  storage!.sqlite.close();
  storage = null;
}

describe("consistent offline backups", () => {
  it("restores database, immutable files, credentials, executable workspace files and scheduler state into a fresh directory", async () => {
    const token = storage!.accessToken;
    const instance = storage!.instanceId;
    const browser = browserPermissionsSchema.parse({
      mode: "observe",
      session: "default",
      allowedOrigins: ["https://saved.example"],
    });
    const browserState = {
      cookies: [],
      origins: [
        {
          origin: "https://saved.example",
          localStorage: [{ name: "login", value: "saved-browser-credential" }],
        },
      ],
    };
    new DefaultBrowserProfileStore(storage!.db, storage!.secretsKey).save(browserState, browser);
    close();
    await createBackup(dataDir, backup);
    const manifest = await verifyBackup(backup);
    expect(manifest.instanceId).toBe(instance);
    const target = join(root, "restored");
    await restoreBackup(backup, target);
    storage = bootstrapStorage(loadConfig({ NODE_ENV: "test", VEKTOR_DATA_DIR: target }));
    expect(storage.instanceId).toBe(instance);
    expect(storage.accessToken).toBe(token);
    expect(new DefaultBrowserProfileStore(storage.db, storage.secretsKey).load(browser)).toEqual(
      browserState,
    );
    expect(getSetting(storage.db, "scheduler.paused")).toBe(true);
    expect(getSetting(storage.db, "runtime.emergencyStopped")).toBe(true);
    expect(
      decryptSecret(
        getSetting(storage.db, "provider.openrouter.key") as string,
        storage.secretsKey,
      ),
    ).toBe("synthetic-backup-provider-key");
    const file = (await readdir(join(target, "files")))[0]!;
    expect(await readFile(join(target, "files", file), "utf8")).toBe("Original attachment\n");
    expect(await readFile(join(target, "workspace", "script-link"), "utf8")).toBe(
      "echo restored\n",
    );
    expect((await stat(join(target, "workspace", "script.sh"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(target, "secrets.key"))).mode & 0o777).toBe(0o600);
  });
  it("refuses a running owner's data and never overwrites an existing backup or restore target", async () => {
    close();
    const release = await acquireDataLock(dataDir);
    try {
      await expect(createBackup(dataDir, backup)).rejects.toThrow("in use");
    } finally {
      await release();
    }
    await createBackup(dataDir, backup);
    await expect(createBackup(dataDir, backup)).rejects.toThrow("already exists");
    const target = join(root, "existing");
    await mkdir(target);
    await writeFile(join(target, "keep"), "keep");
    await expect(restoreBackup(backup, target)).rejects.toThrow("empty");
    expect(await readFile(join(target, "keep"), "utf8")).toBe("keep");
  });
  it("rejects corruption, traversal and missing referenced attachments before restoring", async () => {
    close();
    await createBackup(dataDir, backup);
    const manifestPath = join(backup, "manifest.json");
    const original = await readFile(manifestPath, "utf8");
    const manifest = JSON.parse(original);
    manifest.entries[0].path = "../escaped.db";
    await writeFile(manifestPath, JSON.stringify(manifest));
    await expect(restoreBackup(backup, join(root, "target"))).rejects.toThrow("Unsafe");
    await writeFile(manifestPath, original);
    const file = (await readdir(join(backup, "files")))[0]!;
    await writeFile(join(backup, "files", file), "corrupt");
    await expect(verifyBackup(backup)).rejects.toThrow("checksum");
    expect((await readdir(root)).includes("target")).toBe(false);
  });
  it("rejects workspace links escaping the workspace and special paths without leaving a usable partial backup", async () => {
    await symlink("../../secrets.key", join(dataDir, "workspace", "escape"));
    close();
    await expect(createBackup(dataDir, backup)).rejects.toThrow("outside the workspace");
    expect(await readdir(root)).toEqual(["data"]);
  });
  it("refuses interrupted restores and migrations from an incompatible build", async () => {
    close();
    await writeFile(join(dataDir, ".restore-in-progress"), "interrupted");
    expect(() =>
      bootstrapStorage(loadConfig({ NODE_ENV: "test", VEKTOR_DATA_DIR: dataDir })),
    ).toThrow("interrupted restore");
    await rm(join(dataDir, ".restore-in-progress"));
    const { openDatabase } = await import("@vektor/db");
    const opened = openDatabase(join(dataDir, "vektor.db"));
    opened.sqlite
      .prepare(
        "UPDATE __drizzle_migrations SET hash='future-build' WHERE created_at=(SELECT MAX(created_at) FROM __drizzle_migrations)",
      )
      .run();
    opened.sqlite.close();
    await expect(createBackup(dataDir, backup)).rejects.toThrow("incompatible");
    const check = openReadOnlyDatabase(join(dataDir, "vektor.db"));
    expect(
      check.prepare("SELECT hash FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1").get(),
    ).toEqual({ hash: "future-build" });
    check.close();
  });
});
