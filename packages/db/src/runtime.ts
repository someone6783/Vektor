import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, lt } from "drizzle-orm";
import type { VektorDatabase } from "./client.js";
import { approvals, auditLog, toolCalls } from "./schema.js";

export function createToolCall(
  db: VektorDatabase,
  input: { runId: string; providerCallId: string; name: string; input: unknown },
) {
  return db
    .insert(toolCalls)
    .values({
      id: randomUUID(),
      runId: input.runId,
      providerCallId: input.providerCallId,
      name: input.name,
      inputJson: JSON.stringify(input.input ?? null),
      status: "requested",
      createdAt: new Date(),
    })
    .returning()
    .get();
}
export function updateToolCall(db: VektorDatabase, id: string, status: string, output?: string) {
  db.update(toolCalls)
    .set({ status, ...(output !== undefined ? { output, endedAt: new Date() } : {}) })
    .where(eq(toolCalls.id, id))
    .run();
}
export function listToolCalls(db: VektorDatabase, runId: string) {
  return db.select().from(toolCalls).where(eq(toolCalls.runId, runId)).all();
}
export function createApproval(
  db: VektorDatabase,
  runId: string,
  toolCallId: string,
  command: string,
) {
  return db
    .insert(approvals)
    .values({
      id: randomUUID(),
      runId,
      toolCallId,
      command,
      status: "pending",
      createdAt: new Date(),
    })
    .returning()
    .get();
}
export function getApproval(db: VektorDatabase, id: string) {
  return db.select().from(approvals).where(eq(approvals.id, id)).get();
}
export function listApprovals(db: VektorDatabase, runId?: string) {
  return db
    .select()
    .from(approvals)
    .where(runId ? eq(approvals.runId, runId) : eq(approvals.status, "pending"))
    .all();
}
export function resolveApproval(db: VektorDatabase, id: string, status: string): boolean {
  return (
    db
      .update(approvals)
      .set({ status, resolvedAt: new Date() })
      .where(and(eq(approvals.id, id), eq(approvals.status, "pending")))
      .run().changes === 1
  );
}
export function closeRunTools(db: VektorDatabase, runId: string, reason: string) {
  db.update(approvals)
    .set({ status: "cancelled", resolvedAt: new Date() })
    .where(and(eq(approvals.runId, runId), eq(approvals.status, "pending")))
    .run();
  db.update(toolCalls)
    .set({ status: "cancelled", output: reason, endedAt: new Date() })
    .where(
      and(
        eq(toolCalls.runId, runId),
        inArray(toolCalls.status, ["requested", "waiting", "running"]),
      ),
    )
    .run();
}
export function appendAudit(
  db: VektorDatabase,
  action: string,
  runId: string | null,
  details: unknown = {},
) {
  db.insert(auditLog)
    .values({ action, runId, detailsJson: JSON.stringify(details), createdAt: new Date() })
    .run();
}
export function listAudit(db: VektorDatabase, before?: number, limit = 50) {
  return db
    .select()
    .from(auditLog)
    .where(before ? lt(auditLog.id, before) : undefined)
    .orderBy(desc(auditLog.id))
    .limit(Math.min(100, Math.max(1, limit)))
    .all();
}
