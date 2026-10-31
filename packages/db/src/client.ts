import { mkdirSync } from "node:fs";
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
