import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { VektorDatabase } from "./client.js";
import { jobRuns, runs, scheduledJobs, schedulerLease } from "./schema.js";

export type JobRecord = typeof scheduledJobs.$inferSelect;
export type JobRunRecord = typeof jobRuns.$inferSelect;
export function createJob(
  db: VektorDatabase,
  input: Omit<typeof scheduledJobs.$inferInsert, "id" | "createdAt" | "updatedAt">,
  now: number,
): JobRecord {
  return db
    .insert(scheduledJobs)
    .values({ ...input, id: randomUUID(), createdAt: new Date(now), updatedAt: new Date(now) })
    .returning()
    .get();
}
export function getJob(db: VektorDatabase, id: string): JobRecord | undefined {
  return db.select().from(scheduledJobs).where(eq(scheduledJobs.id, id)).get();
}
export function listJobs(db: VektorDatabase, includeDeleted = false): JobRecord[] {
  return db
    .select()
    .from(scheduledJobs)
    .where(includeDeleted ? undefined : isNull(scheduledJobs.deletedAt))
    .orderBy(asc(scheduledJobs.createdAt), asc(scheduledJobs.id))
    .all();
}
export function updateJob(
  db: VektorDatabase,
  id: string,
  patch: Partial<typeof scheduledJobs.$inferInsert>,
  now: number,
): JobRecord | undefined {
  return db
    .update(scheduledJobs)
    .set({ ...patch, updatedAt: new Date(now), version: sql`${scheduledJobs.version} + 1` })
    .where(eq(scheduledJobs.id, id))
    .returning()
    .get();
}
export function dueJobs(db: VektorDatabase, now: number): JobRecord[] {
  return db
    .select()
    .from(scheduledJobs)
    .where(
      and(
        eq(scheduledJobs.enabled, true),
        isNull(scheduledJobs.deletedAt),
        lte(scheduledJobs.nextRunAt, new Date(now)),
        or(isNull(scheduledJobs.leaseUntil), lte(scheduledJobs.leaseUntil, new Date(now))),
      ),
    )
    .orderBy(asc(scheduledJobs.nextRunAt))
    .limit(20)
    .all();
}
export function claimJob(db: VektorDatabase, job: JobRecord, owner: string, now: number): boolean {
  if (!job.nextRunAt) return false;
  return (
    db
      .update(scheduledJobs)
      .set({ leaseOwner: owner, leaseUntil: new Date(now + 30_000) })
      .where(
        and(
          eq(scheduledJobs.id, job.id),
          eq(scheduledJobs.version, job.version),
          eq(scheduledJobs.enabled, true),
          isNull(scheduledJobs.deletedAt),
          eq(scheduledJobs.nextRunAt, job.nextRunAt),
          or(isNull(scheduledJobs.leaseUntil), lte(scheduledJobs.leaseUntil, new Date(now))),
        ),
      )
      .run().changes === 1
  );
}
export function releaseJob(db: VektorDatabase, id: string, owner: string) {
  db.update(scheduledJobs)
    .set({ leaseOwner: null, leaseUntil: null })
    .where(and(eq(scheduledJobs.id, id), eq(scheduledJobs.leaseOwner, owner)))
    .run();
}
export function acquireSchedulerLease(db: VektorDatabase, owner: string, now: number): boolean {
  db.insert(schedulerLease)
    .values({ id: "scheduler", owner, expiresAt: new Date(now + 30_000) })
    .onConflictDoUpdate({
      target: schedulerLease.id,
      set: { owner, expiresAt: new Date(now + 30_000) },
      setWhere: or(eq(schedulerLease.owner, owner), lte(schedulerLease.expiresAt, new Date(now))),
    })
    .run();
  return (
    db
      .select()
      .from(schedulerLease)
      .where(and(eq(schedulerLease.id, "scheduler"), eq(schedulerLease.owner, owner)))
      .get() !== undefined
  );
}
export function releaseSchedulerLease(db: VektorDatabase, owner: string) {
  db.delete(schedulerLease)
    .where(and(eq(schedulerLease.id, "scheduler"), eq(schedulerLease.owner, owner)))
    .run();
}
export function addJobRun(db: VektorDatabase, input: typeof jobRuns.$inferInsert): JobRunRecord {
  return db.insert(jobRuns).values(input).returning().get();
}
export function hasRunningJob(db: VektorDatabase, jobId: string): boolean {
  return !!db
    .select({ id: jobRuns.id })
    .from(jobRuns)
    .where(and(eq(jobRuns.jobId, jobId), eq(jobRuns.status, "running")))
    .get();
}
export function listJobRuns(db: VektorDatabase, jobId: string, before?: number): JobRunRecord[] {
  return db
    .select()
    .from(jobRuns)
    .where(and(eq(jobRuns.jobId, jobId), before ? lt(jobRuns.id, before) : undefined))
    .orderBy(desc(jobRuns.id))
    .limit(30)
    .all();
}
export function completeJobRuns(db: VektorDatabase, now: number) {
  const pending = db
    .select({ execution: jobRuns, run: runs })
    .from(jobRuns)
    .innerJoin(runs, eq(jobRuns.runId, runs.id))
    .where(eq(jobRuns.status, "running"))
    .all();
  const completed = [];
  for (const { execution, run } of pending) {
    if (run.status === "running") continue;
    const error = run.error ?? (run.status === "cancelled" ? "Run cancelled." : null);
    db.update(jobRuns)
      .set({ status: run.status, error, endedAt: run.endedAt ?? new Date(now) })
      .where(eq(jobRuns.id, execution.id))
      .run();
    db.update(scheduledJobs)
      .set({ lastStatus: run.status, lastError: error })
      .where(eq(scheduledJobs.id, execution.jobId))
      .run();
    completed.push({ execution, run, error });
  }
  return completed;
}
