import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import type { VektorDatabase } from "./client.js";

export const defaultMigrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

export function runMigrations(
  db: VektorDatabase,
  migrationsFolder: string = defaultMigrationsFolder,
): void {
  migrate(db, { migrationsFolder });
}
