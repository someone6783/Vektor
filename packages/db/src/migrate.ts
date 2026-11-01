import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import type { VektorDatabase, SqliteConnection } from "./client.js";

export const defaultMigrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

export function verifyMigrationHistory(sqlite: SqliteConnection, folder = defaultMigrationsFolder) {
  if (
    !sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations'")
      .get()
  )
    return;
  const applied = sqlite
    .prepare("SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at")
    .all() as Array<{ hash: string; created_at: number }>;
  const known = readMigrationFiles({ migrationsFolder: folder });
  if (
    applied.some(
      (migration, index) =>
        migration.hash !== known[index]?.hash ||
        migration.created_at !== known[index]?.folderMillis,
    )
  )
    throw new Error(
      "Database migrations are newer than or incompatible with this build. Use the matching/newer version, or restore a pre-upgrade backup into a fresh volume.",
    );
}

export function runMigrations(
  db: VektorDatabase,
  migrationsFolder: string = defaultMigrationsFolder,
): void {
  migrate(db, { migrationsFolder });
}
