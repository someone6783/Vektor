import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { VektorDatabase } from "./client.js";
import { settings } from "./schema.js";

export function getSetting(db: VektorDatabase, key: string): unknown {
  const row = db.select().from(settings).where(eq(settings.key, key)).get();
  return row ? (JSON.parse(row.valueJson) as unknown) : undefined;
}

export function setSetting(db: VektorDatabase, key: string, value: unknown): void {
  if (value === undefined) {
    throw new Error(`Cannot persist undefined setting: ${key}`);
  }

  const updatedAt = new Date();
  const valueJson = JSON.stringify(value);

  db.insert(settings)
    .values({ key, valueJson, updatedAt })
    .onConflictDoUpdate({
      target: settings.key,
      set: { valueJson, updatedAt },
    })
    .run();
}

export function getOrCreateInstanceId(db: VektorDatabase): string {
  const existing = getSetting(db, "app.instance_id");
  if (typeof existing === "string" && existing.length > 0) {
    return existing;
  }

  const instanceId = randomUUID();
  setSetting(db, "app.instance_id", instanceId);
  return instanceId;
}
