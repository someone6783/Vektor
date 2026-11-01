import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

export type VektorDatabase = BetterSQLite3Database<typeof schema>;
export type SqliteConnection = InstanceType<typeof Database>;

export interface OpenedDatabase {
  sqlite: SqliteConnection;
  db: VektorDatabase;
}

export function openDatabase(filename: string): OpenedDatabase {
  mkdirSync(dirname(filename), { recursive: true });

  const sqlite = new Database(filename);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");

  return {
    sqlite,
    db: drizzle(sqlite, { schema }),
  };
}

export function openReadOnlyDatabase(filename: string): SqliteConnection {
  const sqlite = new Database(filename, { readonly: true, fileMustExist: true });
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  return sqlite;
}

// A separate SQLite file provides an OS-backed exclusive lifetime lock, even
// while the main database uses WAL. Death releases it without a stale timeout.
export function lockDataDirectory(filename: string): () => void {
  const sqlite = new Database(filename);
  try {
    chmodSync(filename, 0o600);
    sqlite.pragma("busy_timeout = 0");
    sqlite.exec("BEGIN EXCLUSIVE");
    return () => sqlite.close();
  } catch (error) {
    sqlite.close();
    throw error;
  }
}

export async function snapshotDatabase(sqlite: SqliteConnection, filename: string): Promise<void> {
  await sqlite.backup(filename);
  const snapshot = new Database(filename);
  try {
    // A standalone snapshot must also work on a read-only backup volume.
    snapshot.pragma("journal_mode = DELETE");
  } finally {
    snapshot.close();
  }
}
