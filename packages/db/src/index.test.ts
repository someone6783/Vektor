import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getOrCreateInstanceId,
  createChannel,
  createMessage,
  getMessage,
  getProfile,
  listAttachments,
  createAttachment,
  linkMessageAttachments,
  listMessageAttachments,
  getRun,
  listToolCalls,
  defaultMigrationsFolder,
  getSetting,
  openDatabase,
  runMigrations,
  setSetting,
  type SqliteConnection,
} from "./index.js";

let tempDir: string | undefined;
let connection: SqliteConnection | undefined;
function legacyProfile(sqlite: SqliteConnection, name: string) {
  const id = "legacy-profile";
  sqlite
    .prepare(
      "INSERT INTO profiles (id, name, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(id, name, "test", Date.now(), Date.now());
  return { id };
}

function setup() {
  tempDir = mkdtempSync(join(tmpdir(), "vektor-db-"));
  const opened = openDatabase(join(tempDir, "vektor.db"));
  connection = opened.sqlite;
  runMigrations(opened.db);
  return { ...opened, filename: join(tempDir, "vektor.db") };
}

afterEach(() => {
  connection?.close();
  connection = undefined;
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("database bootstrap", () => {
  it("upgrades Phase 3 data while preserving attachment inclusion, links, and completed runs", () => {
    tempDir = mkdtempSync(join(tmpdir(), "vektor-runtime-migration-"));
    const legacy = join(tempDir, "legacy");
    mkdirSync(join(legacy, "meta"), { recursive: true });
    const journal = JSON.parse(
      readFileSync(join(defaultMigrationsFolder, "meta/_journal.json"), "utf8"),
    ) as { entries: Array<{ tag: string; idx: number }> };
    journal.entries = journal.entries.filter((entry) => entry.idx < 3);
    writeFileSync(join(legacy, "meta/_journal.json"), JSON.stringify(journal));
    for (const entry of journal.entries)
      cpSync(join(defaultMigrationsFolder, `${entry.tag}.sql`), join(legacy, `${entry.tag}.sql`));
    const { db, sqlite } = openDatabase(join(tempDir, "vektor.db"));
    connection = sqlite;
    runMigrations(db, legacy);
    const profile = legacyProfile(sqlite, "Phase 3");
    const channel = createChannel(db, { name: "Files", profileId: profile.id });
    const message = createMessage(db, {
      channelId: channel.id,
      role: "user",
      content: "Saved files",
    });
    const attachment = createAttachment(db, {
      id: "legacy-file",
      channelId: channel.id,
      filename: "notes.txt",
      mime: "text/plain",
      size: 4,
      kind: "text",
      included: false,
      extractedText: "kept",
      createdAt: new Date(),
    });
    linkMessageAttachments(db, message.id, [attachment.id]);
    sqlite
      .prepare(
        "insert into runs (id, channel_id, profile_id, user_message_id, model, status, started_at) values (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("old-run", channel.id, profile.id, message.id, "test", "completed", Date.now());
    runMigrations(db);
    expect(getProfile(db, profile.id)?.browser).toEqual({
      mode: "off",
      session: "separate",
      display: "headless",
      allowedOrigins: [],
      localOrigins: [],
    });
    expect(getRun(db, "old-run")).toMatchObject({
      status: "completed",
      terminalMode: "no-terminal",
    });
    expect(listMessageAttachments(db, message.id)[0]).toMatchObject({
      included: false,
      extractedText: "kept",
    });
    expect(listToolCalls(db, "old-run")).toEqual([]);
  });
  it("upgrades a Phase 2 database without losing messages or settings", () => {
    tempDir = mkdtempSync(join(tmpdir(), "vektor-migration-"));
    const legacy = join(tempDir, "legacy");
    mkdirSync(join(legacy, "meta"), { recursive: true });
    const journal = JSON.parse(
      readFileSync(join(defaultMigrationsFolder, "meta/_journal.json"), "utf8"),
    ) as { entries: Array<{ tag: string; idx: number }> };
    journal.entries = journal.entries.filter((entry) => entry.idx < 2);
    writeFileSync(join(legacy, "meta/_journal.json"), JSON.stringify(journal));
    for (const entry of journal.entries)
      cpSync(join(defaultMigrationsFolder, `${entry.tag}.sql`), join(legacy, `${entry.tag}.sql`));
    const { db, sqlite } = openDatabase(join(tempDir, "vektor.db"));
    connection = sqlite;
    runMigrations(db, legacy);
    setSetting(db, "existing", { kept: true });
    const profile = legacyProfile(sqlite, "Legacy profile");
    const channel = createChannel(db, { name: "Legacy channel", profileId: profile.id });
    const message = createMessage(db, {
      channelId: channel.id,
      role: "user",
      content: "Keep my history",
    });
    runMigrations(db);
    expect(getMessage(db, message.id)?.content).toBe("Keep my history");
    expect(getSetting(db, "existing")).toEqual({ kept: true });
    expect(listAttachments(db, channel.id)).toEqual([]);
    expect(sqlite.prepare("pragma table_info(runs)").all()).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "context_json" })]),
    );
  });
  it("enables WAL and foreign keys", () => {
    const { sqlite } = setup();

    expect(sqlite.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(sqlite.pragma("busy_timeout", { simple: true })).toBe(5000);
  });

  it("runs migrations transactionally and idempotently", () => {
    const { db, sqlite } = setup();

    expect(() => runMigrations(db)).not.toThrow();
    const row = sqlite.prepare("select count(*) as count from __drizzle_migrations").get() as {
      count: number;
    };

    expect(row.count).toBeGreaterThan(0);
  });

  it("round-trips JSON settings", () => {
    const { db } = setup();

    setSetting(db, "test.value", { enabled: true, count: 2 });
    expect(getSetting(db, "test.value")).toEqual({ enabled: true, count: 2 });

    setSetting(db, "test.value", { enabled: false });
    expect(getSetting(db, "test.value")).toEqual({ enabled: false });
    expect(getSetting(db, "test.missing")).toBeUndefined();
  });

  it("persists the instance id across reopens", () => {
    const first = setup();
    const instanceId = getOrCreateInstanceId(first.db);
    first.sqlite.close();
    connection = undefined;

    const second = openDatabase(first.filename);
    connection = second.sqlite;
    runMigrations(second.db);

    expect(getOrCreateInstanceId(second.db)).toBe(instanceId);
  });
});
