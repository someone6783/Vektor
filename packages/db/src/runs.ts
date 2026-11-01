import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, lt, max, sql } from "drizzle-orm";
import type { VektorDatabase } from "./client.js";
import { runEvents, runs } from "./schema.js";

export type RunStatus = "running" | "completed" | "failed" | "cancelled";

export interface RunRecord {
  id: string;
  channelId: string;
  profileId: string;
  userMessageId: string;
  model: string;
  runner: "native" | "cli";
  provider: "openrouter" | "stub" | "unknown";
  providerCalls: number;
  jobId: string | null;
  status: RunStatus;
  error: string | null;
  usage: unknown;
  context: unknown;
  includeHistory: boolean;
  terminalMode: "no-terminal" | "basic" | "full-access" | "full-unrestricted";
  startedAt: number;
  endedAt: number | null;
}

export interface CreateRunRecordInput {
  channelId: string;
  profileId: string;
  userMessageId: string;
  model: string;
  context?: unknown;
  includeHistory?: boolean;
  terminalMode?: "no-terminal" | "basic" | "full-access" | "full-unrestricted";
  jobId?: string | null;
}

export interface RunEventRecord {
  seq: number;
  type: string;
  payloadJson: string;
}

function toRecord(row: typeof runs.$inferSelect): RunRecord {
  let usage: unknown = null;
  if (row.usageJson) {
    try {
      usage = JSON.parse(row.usageJson) as unknown;
    } catch {
      usage = null;
    }
  }

  return {
    id: row.id,
    channelId: row.channelId,
    profileId: row.profileId,
    userMessageId: row.userMessageId,
    model: row.model,
    runner: row.runner as "native" | "cli",
    provider: row.provider as RunRecord["provider"],
    providerCalls: row.providerCalls,
    jobId: row.jobId,
    status: row.status as RunStatus,
    error: row.error,
    usage,
    context: row.contextJson ? (JSON.parse(row.contextJson) as unknown) : null,
    includeHistory: row.includeHistory,
    terminalMode: row.terminalMode as RunRecord["terminalMode"],
    startedAt: row.startedAt.getTime(),
    endedAt: row.endedAt?.getTime() ?? null,
  };
}

export function createRun(db: VektorDatabase, input: CreateRunRecordInput): RunRecord {
  const row = {
    id: randomUUID(),
    channelId: input.channelId,
    profileId: input.profileId,
    userMessageId: input.userMessageId,
    model: input.model,
    runner: "native" as const,
    provider: "unknown" as const,
    providerCalls: 0,
    jobId: input.jobId ?? null,
    status: "running" as const,
    error: null,
    usageJson: null,
    contextJson: input.context ? JSON.stringify(input.context) : null,
    includeHistory: input.includeHistory ?? true,
    terminalMode: input.terminalMode ?? "no-terminal",
    startedAt: new Date(),
    endedAt: null,
  };

  db.insert(runs).values(row).run();
  return toRecord(row);
}

export function getRun(db: VektorDatabase, id: string): RunRecord | undefined {
  const row = db.select().from(runs).where(eq(runs.id, id)).get();
  return row ? toRecord(row) : undefined;
}

export function getActiveRun(db: VektorDatabase, channelId: string): RunRecord | undefined {
  const row = db
    .select()
    .from(runs)
    .where(and(eq(runs.channelId, channelId), eq(runs.status, "running")))
    .orderBy(desc(runs.startedAt))
    .get();

  return row ? toRecord(row) : undefined;
}

export function getLatestRun(db: VektorDatabase, channelId: string): RunRecord | undefined {
  const row = db
    .select()
    .from(runs)
    .where(eq(runs.channelId, channelId))
    .orderBy(desc(runs.startedAt), sql`rowid desc`)
    .get();
  return row ? toRecord(row) : undefined;
}

export function listRunningRuns(db: VektorDatabase): RunRecord[] {
  return db
    .select()
    .from(runs)
    .where(eq(runs.status, "running"))
    .orderBy(asc(runs.startedAt))
    .all()
    .map(toRecord);
}

export function listRuns(db: VektorDatabase, channelId?: string, before?: number) {
  return db
    .select()
    .from(runs)
    .where(
      and(
        channelId ? eq(runs.channelId, channelId) : undefined,
        before ? lt(runs.startedAt, new Date(before)) : undefined,
      ),
    )
    .orderBy(desc(runs.startedAt), sql`rowid desc`)
    .limit(30)
    .all()
    .map(toRecord);
}

export interface UpdateRunRecordInput {
  provider?: RunRecord["provider"];
  providerCalls?: number;
  status?: RunStatus;
  error?: string | null;
  usage?: unknown;
  endedAt?: number | null;
}

export function updateRun(
  db: VektorDatabase,
  id: string,
  patch: UpdateRunRecordInput,
): RunRecord | undefined {
  const set: Partial<typeof runs.$inferInsert> = {};
  if (patch.provider !== undefined) set.provider = patch.provider;
  if (patch.providerCalls !== undefined) set.providerCalls = patch.providerCalls;

  if (patch.status !== undefined) set.status = patch.status;
  if (patch.error !== undefined) set.error = patch.error;
  if (patch.usage !== undefined) set.usageJson = JSON.stringify(patch.usage);
  if (patch.endedAt !== undefined) {
    set.endedAt = patch.endedAt === null ? null : new Date(patch.endedAt);
  }

  if (Object.keys(set).length === 0) {
    return getRun(db, id);
  }

  db.update(runs).set(set).where(eq(runs.id, id)).run();
  return getRun(db, id);
}

export function appendRunEvent(
  db: VektorDatabase,
  event: { runId: string; seq: number; type: string; payloadJson: string },
): void {
  db.insert(runEvents)
    .values({
      runId: event.runId,
      seq: event.seq,
      type: event.type,
      payloadJson: event.payloadJson,
      createdAt: new Date(),
    })
    .run();
}

export function listRunEvents(db: VektorDatabase, runId: string, after = 0): RunEventRecord[] {
  return db
    .select()
    .from(runEvents)
    .where(and(eq(runEvents.runId, runId), gt(runEvents.seq, after)))
    .orderBy(asc(runEvents.seq))
    .all()
    .map((row) => ({ seq: row.seq, type: row.type, payloadJson: row.payloadJson }));
}

export function getMaxRunSeq(db: VektorDatabase, runId: string): number {
  const row = db
    .select({ value: max(runEvents.seq) })
    .from(runEvents)
    .where(eq(runEvents.runId, runId))
    .get();

  return row?.value ?? 0;
}
