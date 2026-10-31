import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getOrCreateInstanceId,
  getSetting,
  openDatabase,
  runMigrations,
  setSetting,
  type SqliteConnection,
} from "./index.js";

let tempDir: string | undefined;
let connection: SqliteConnection | undefined;

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
