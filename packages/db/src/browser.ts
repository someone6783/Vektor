import { randomUUID } from "node:crypto";
import { desc, eq, lte, sql } from "drizzle-orm";
import type { VektorDatabase } from "./client.js";
import { browserArtifacts } from "./schema.js";

export function pruneBrowserArtifacts(db: VektorDatabase, now = Date.now()) {
  db.delete(browserArtifacts)
    .where(lte(browserArtifacts.expiresAt, new Date(now)))
    .run();
}
export function saveBrowserArtifact(
  db: VektorDatabase,
  runId: string,
  origin: string,
  jpeg: Buffer,
  ttlMs: number,
) {
  pruneBrowserArtifacts(db);
  if (jpeg.length > 1024 * 1024) return null;
  const total = db
    .select({ bytes: sql<number>`coalesce(sum(${browserArtifacts.size}), 0)` })
    .from(browserArtifacts)
    .get()!.bytes;
  if (total + jpeg.length > 32 * 1024 * 1024) return null;
  const value = {
    id: randomUUID(),
    runId,
    origin,
    jpeg: jpeg.toString("base64"),
    size: jpeg.length,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + ttlMs),
  };
  db.insert(browserArtifacts).values(value).run();
  return value.id;
}
export function listBrowserArtifacts(db: VektorDatabase, runId: string) {
  pruneBrowserArtifacts(db);
  return db
    .select({
      id: browserArtifacts.id,
      runId: browserArtifacts.runId,
      origin: browserArtifacts.origin,
      size: browserArtifacts.size,
      createdAt: browserArtifacts.createdAt,
      expiresAt: browserArtifacts.expiresAt,
    })
    .from(browserArtifacts)
    .where(eq(browserArtifacts.runId, runId))
    .orderBy(desc(browserArtifacts.createdAt))
    .limit(50)
    .all();
}
export function getBrowserArtifact(db: VektorDatabase, id: string) {
  pruneBrowserArtifacts(db);
  return db.select().from(browserArtifacts).where(eq(browserArtifacts.id, id)).get();
}
export function deleteBrowserArtifacts(db: VektorDatabase, runId: string) {
  db.delete(browserArtifacts).where(eq(browserArtifacts.runId, runId)).run();
}
