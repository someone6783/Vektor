import { randomUUID } from "node:crypto";
import { desc, eq, lte, sql } from "drizzle-orm";
import type { VektorDatabase } from "./client.js";
import { computerArtifacts } from "./schema.js";

export function pruneComputerArtifacts(db: VektorDatabase, now = Date.now()) {
  db.delete(computerArtifacts)
    .where(lte(computerArtifacts.expiresAt, new Date(now)))
    .run();
}
export function saveComputerArtifact(
  db: VektorDatabase,
  runId: string,
  actionId: string,
  action: string,
  stage: "before" | "after",
  jpeg: Buffer,
  ttlMs: number,
) {
  pruneComputerArtifacts(db);
  if (ttlMs <= 0 || jpeg.length > 4 * 1024 * 1024) return null;
  const total = db
    .select({ bytes: sql<number>`coalesce(sum(${computerArtifacts.size}), 0)` })
    .from(computerArtifacts)
    .get()!.bytes;
  if (total + jpeg.length > 32 * 1024 * 1024) return null;
  const value = {
    id: randomUUID(),
    runId,
    actionId,
    action,
    stage,
    jpeg: jpeg.toString("base64"),
    size: jpeg.length,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + ttlMs),
  };
  db.insert(computerArtifacts).values(value).run();
  return value.id;
}
export function listComputerArtifacts(db: VektorDatabase, runId: string) {
  pruneComputerArtifacts(db);
  return db
    .select({
      id: computerArtifacts.id,
      runId: computerArtifacts.runId,
      actionId: computerArtifacts.actionId,
      action: computerArtifacts.action,
      stage: computerArtifacts.stage,
      size: computerArtifacts.size,
      createdAt: computerArtifacts.createdAt,
      expiresAt: computerArtifacts.expiresAt,
    })
    .from(computerArtifacts)
    .where(eq(computerArtifacts.runId, runId))
    .orderBy(desc(computerArtifacts.createdAt))
    .limit(50)
    .all();
}
export function getComputerArtifact(db: VektorDatabase, id: string) {
  pruneComputerArtifacts(db);
  return db.select().from(computerArtifacts).where(eq(computerArtifacts.id, id)).get();
}
export function deleteComputerArtifacts(db: VektorDatabase, runId: string) {
  db.delete(computerArtifacts).where(eq(computerArtifacts.runId, runId)).run();
}
