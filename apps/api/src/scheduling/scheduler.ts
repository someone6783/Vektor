import { randomUUID } from "node:crypto";
import {
  acquireSchedulerLease,
  addJobRun,
  appendAudit,
  claimJob,
  completeJobRuns,
  createJob,
  createMessage,
  createRun,
  dueJobs,
  getActiveRun,
  getChannel,
  getJob,
  getProfile,
  getSetting,
  hasRunningJob,
  listJobs,
  releaseJob,
  releaseSchedulerLease,
  setSetting,
  updateJob,
  updateRun,
  appendRunEvent,
  type JobRecord,
  type VektorDatabase,
  type JobRunRecord,
} from "@vektor/db";
import { scheduledJobSchema, type CreateJob, type UpdateJob } from "@vektor/shared";
import { checkContextBudget, type ContextService } from "../context.js";
import type { RunManager } from "../runs/run-manager.js";
import { RuntimeError } from "../runtime/terminal.js";
import { nextOccurrence, previewSchedule } from "./schedule.js";

export function jobView(job: JobRecord) {
  return scheduledJobSchema.parse({
    ...job,
    nextRunAt: job.nextRunAt?.toISOString() ?? null,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
    deletedAt: job.deletedAt?.toISOString() ?? null,
  });
}
interface Options {
  db: VektorDatabase;
  manager: RunManager;
  context: ContextService;
  redact: (text: string) => string;
  enabled: boolean;
  tickMs: number;
  now?: () => number;
  onError: (error: unknown) => void;
}
export class Scheduler {
  private readonly owner = randomUUID();
  private readonly startedAt: number;
  private busy = false;
  private closing = false;
  private timer?: NodeJS.Timeout;
  private pending: Promise<unknown> | null = null;
  private readonly unsubscribe: () => void;
  readonly now: () => number;
  constructor(readonly options: Options) {
    this.now = options.now ?? Date.now;
    this.startedAt = this.now();
    this.unsubscribe = options.manager.onFinished(() => this.reconcile());
    this.reconcile();
  }
  get state() {
    return {
      enabled: this.options.enabled,
      paused: getSetting(this.options.db, "scheduler.paused") === true,
      emergencyStopped: this.options.manager.stopped,
      tickMs: this.options.tickMs,
    };
  }
  start(): void {
    if (!this.options.enabled || this.timer || this.closing) return;
    void this.tick().catch(this.options.onError);
    this.timer = setInterval(() => {
      void this.tick().catch(this.options.onError);
    }, this.options.tickMs);
    this.timer.unref();
  }
  async stop(): Promise<void> {
    this.closing = true;
    clearInterval(this.timer);
    this.timer = undefined;
    await this.pending?.catch(this.options.onError);
    this.unsubscribe();
    releaseSchedulerLease(this.options.db, this.owner);
  }
  pause(): void {
    setSetting(
      this.options.db,
      "scheduler.pauseVersion",
      Number(getSetting(this.options.db, "scheduler.pauseVersion") ?? 0) + 1,
    );
    setSetting(this.options.db, "scheduler.paused", true);
    appendAudit(this.options.db, "scheduler.paused", null);
  }
  resume(): void {
    if (this.state.paused) setSetting(this.options.db, "scheduler.resumedAt", this.now());
    setSetting(this.options.db, "scheduler.paused", false);
    appendAudit(this.options.db, "scheduler.resumed", null);
  }
  private target(profileId: string, channelId: string, browserAccess = "off"): void {
    const profile = getProfile(this.options.db, profileId);
    const channel = getChannel(this.options.db, channelId);
    if (!profile || profile.archivedAt !== null || !channel || channel.archivedAt !== null)
      throw new RuntimeError("Choose an active profile and channel.");
    if (
      browserAccess !== "off" &&
      (profile.browser?.mode === "off" ||
        !profile.browser ||
        (browserAccess === "interactive" && profile.browser.mode !== "interactive"))
    )
      throw new RuntimeError(
        "The job's declared browser capability exceeds its profile permissions.",
        403,
      );
  }
  create(input: CreateJob): JobRecord {
    this.target(input.profileId, input.channelId, input.browserAccess);
    if (listJobs(this.options.db).length >= 100)
      throw new RuntimeError(
        "At most 100 scheduled jobs are supported. Delete unused jobs before adding more.",
        409,
      );
    const preview = previewSchedule(input.schedule, input.timezone, this.now());
    const job = createJob(
      this.options.db,
      {
        ...input,
        cron: preview.cron,
        nextRunAt: input.enabled ? new Date(preview.nextRuns[0]!) : null,
      },
      this.now(),
    );
    appendAudit(this.options.db, "job.created", null, {
      jobId: job.id,
      cron: job.cron,
      timezone: job.timezone,
    });
    return job;
  }
  update(id: string, patch: UpdateJob): JobRecord {
    const job = this.get(id);
    const input = { ...job, ...patch };
    if (input.enabled || patch.profileId !== undefined || patch.channelId !== undefined)
      this.target(input.profileId, input.channelId, input.browserAccess);
    const preview = previewSchedule(input.schedule, input.timezone, this.now());
    const reschedule =
      patch.schedule !== undefined || patch.timezone !== undefined || patch.enabled !== undefined;
    const nextRunAt = input.enabled
      ? reschedule
        ? new Date(preview.nextRuns[0]!)
        : job.nextRunAt
      : null;
    const updated = updateJob(
      this.options.db,
      id,
      { ...patch, cron: preview.cron, nextRunAt, leaseOwner: null, leaseUntil: null },
      this.now(),
    )!;
    appendAudit(this.options.db, "job.updated", null, {
      jobId: id,
      fields: Object.keys(patch),
      enabled: updated.enabled,
    });
    return updated;
  }
  remove(id: string): void {
    this.get(id);
    updateJob(
      this.options.db,
      id,
      {
        enabled: false,
        nextRunAt: null,
        deletedAt: new Date(this.now()),
        leaseOwner: null,
        leaseUntil: null,
      },
      this.now(),
    );
    appendAudit(this.options.db, "job.deleted", null, { jobId: id });
  }
  get(id: string): JobRecord {
    const job = getJob(this.options.db, id);
    if (!job || job.deletedAt) throw new RuntimeError("Scheduled job not found.", 404);
    return job;
  }
  reconcile(): void {
    this.options.db.transaction((db) => {
      for (const { execution, run, error } of completeJobRuns(db, this.now())) {
        appendAudit(db, `job.run_${run.status}`, run.id, {
          jobId: execution.jobId,
          jobRunId: execution.id,
        });
        const job = getJob(db, execution.jobId);
        if (job && run.status !== "completed" && getChannel(db, run.channelId)?.archivedAt === null)
          createMessage(db, {
            channelId: run.channelId,
            role: "system",
            content: `[Scheduled job: ${job.name}] ${run.status}: ${error ?? "Run ended without completion."}`,
          });
      }
    });
  }
  async tick(): Promise<void> {
    if (this.busy || this.closing || !this.options.enabled) return;
    this.busy = true;
    this.pending = (async () => {
      this.reconcile();
      if (!acquireSchedulerLease(this.options.db, this.owner, this.now())) return;
      try {
        for (const job of dueJobs(this.options.db, this.now())) {
          if (this.closing) break;
          if (!claimJob(this.options.db, job, this.owner, this.now())) continue;
          try {
            await this.dispatch(job, false);
          } finally {
            releaseJob(this.options.db, job.id, this.owner);
          }
        }
      } finally {
        releaseSchedulerLease(this.options.db, this.owner);
      }
    })();
    try {
      await this.pending;
    } finally {
      this.pending = null;
      this.busy = false;
    }
  }
  async runNow(id: string): Promise<JobRunRecord> {
    if (this.closing || this.busy)
      throw new RuntimeError("Scheduler is processing another change. Try again shortly.", 409);
    if (!this.options.enabled)
      throw new RuntimeError("Scheduler is disabled by backend configuration.", 423);
    this.options.manager.assertCanStart();
    if (this.state.paused)
      throw new RuntimeError("Resume the scheduler before running a job.", 423);
    const job = this.get(id);
    this.busy = true;
    this.pending = (async () => {
      if (!acquireSchedulerLease(this.options.db, this.owner, this.now()))
        throw new RuntimeError(
          "Another scheduler owns the execution lease. Try again shortly.",
          409,
        );
      try {
        const result = await this.dispatch(job, true);
        if (!result)
          throw new RuntimeError("This job changed before it could start. Try again.", 409);
        return result;
      } finally {
        releaseSchedulerLease(this.options.db, this.owner);
      }
    })();
    try {
      return (await this.pending) as JobRunRecord;
    } finally {
      this.pending = null;
      this.busy = false;
    }
  }
  private blocked(
    scheduledFor: number,
    stopVersion: number,
    pauseVersion: number,
    manual: boolean,
  ): string | null {
    const db = this.options.db;
    if (
      this.options.manager.stopped ||
      Number(getSetting(db, "runtime.stopVersion") ?? 0) !== stopVersion ||
      (!manual && scheduledFor <= Number(getSetting(db, "runtime.resumedAt") ?? 0))
    )
      return "emergency_stop";
    if (
      this.state.paused ||
      Number(getSetting(db, "scheduler.pauseVersion") ?? 0) !== pauseVersion ||
      (!manual && scheduledFor <= Number(getSetting(db, "scheduler.resumedAt") ?? 0))
    )
      return "scheduler_paused";
    return null;
  }
  private async dispatch(job: JobRecord, manual: boolean): Promise<JobRunRecord | null> {
    const { db, manager, context, redact } = this.options;
    const scheduledFor = manual ? this.now() : job.nextRunAt!.getTime();
    const stopVersion = Number(getSetting(db, "runtime.stopVersion") ?? 0);
    const pauseVersion = Number(getSetting(db, "scheduler.pauseVersion") ?? 0);
    const occurrenceKey = manual ? `manual:${randomUUID()}` : `scheduled:${scheduledFor}`;
    const late = scheduledFor < this.startedAt || this.now() - scheduledFor >= 60_000;
    const source = manual ? "manual" : late && job.catchUp ? "catch-up" : "schedule";
    let skip = this.blocked(scheduledFor, stopVersion, pauseVersion, manual);
    if (!skip && hasRunningJob(db, job.id)) skip = "overlap";
    if (!skip && getActiveRun(db, job.channelId)) skip = "channel_busy";
    if (!skip && !manual && late && !job.catchUp) skip = "missed";
    let failure: string | null = null;
    let disable = false;
    let prepared: ReturnType<ContextService["prepare"]> | undefined;
    let messages: Awaited<ReturnType<ContextService["messages"]>> | undefined;
    if (!skip) {
      try {
        this.target(job.profileId, job.channelId, job.browserAccess);
        prepared = context.prepare(
          job.channelId,
          { content: job.prompt, profileId: job.profileId, attachmentIds: [] },
          job.profileId,
          undefined,
          job.includeHistory,
        );
        checkContextBudget(prepared.estimate, job.allowTruncation);
        messages = await context.messages(prepared);
      } catch (error) {
        failure = redact(error instanceof Error ? error.message : "Job could not be prepared.");
        const profile = getProfile(db, job.profileId);
        const channel = getChannel(db, job.channelId);
        disable =
          !profile || profile.archivedAt !== null || !channel || channel.archivedAt !== null;
      }
    }
    if (this.closing) return null;
    const now = this.now();
    let next: Date | null = null;
    if (!manual && !disable) {
      try {
        next = new Date(nextOccurrence(job.cron, job.timezone, now));
      } catch (error) {
        failure = redact(error instanceof Error ? error.message : "Invalid stored schedule.");
        disable = true;
      }
    }
    const result = db.transaction((tx) => {
      const current = getJob(tx, job.id);
      if (!current || current.deletedAt || current.version !== job.version) return null;
      if (
        !manual &&
        (!current.enabled ||
          current.nextRunAt?.getTime() !== scheduledFor ||
          current.leaseOwner !== this.owner ||
          (current.leaseUntil?.getTime() ?? 0) <= now)
      )
        return null;
      skip = this.blocked(scheduledFor, stopVersion, pauseVersion, manual) ?? skip;
      if (!skip && hasRunningJob(tx, job.id)) skip = "overlap";
      if (!skip && getActiveRun(tx, job.channelId)) skip = "channel_busy";
      if (!skip && !failure) {
        try {
          this.target(job.profileId, job.channelId, job.browserAccess);
          manager.assertCanStart();
        } catch (error) {
          failure = redact(error instanceof Error ? error.message : "Target unavailable.");
          disable = true;
        }
      }
      const status = skip ? "skipped" : failure ? "failed" : "running";
      let run: ReturnType<typeof createRun> | null = null;
      if (status === "running" && prepared && messages) {
        const message = createMessage(tx, {
          channelId: job.channelId,
          role: "user",
          content: `[Scheduled job: ${job.name} · ${new Date(scheduledFor).toISOString()}]\n${job.prompt}`,
        });
        run = createRun(tx, {
          jobId: job.id,
          channelId: job.channelId,
          profileId: job.profileId,
          userMessageId: message.id,
          model: prepared.model,
          terminalMode: prepared.profile.terminalMode,
          context: prepared.estimate,
          includeHistory: job.includeHistory,
        });
      }
      const execution = addJobRun(tx, {
        jobId: job.id,
        runId: run?.id ?? null,
        occurrenceKey,
        scheduledFor: new Date(scheduledFor),
        source,
        status,
        error: skip ?? failure,
        startedAt: new Date(now),
        endedAt: status === "running" ? null : new Date(now),
      });
      updateJob(
        tx,
        job.id,
        {
          ...(manual ? {} : { nextRunAt: disable ? null : next }),
          ...(disable ? { enabled: false, nextRunAt: null } : {}),
          lastStatus: status,
          lastError: skip ?? failure,
          leaseOwner: null,
          leaseUntil: null,
        },
        now,
      );
      appendAudit(tx, `job.run_${status}`, run?.id ?? null, {
        jobId: job.id,
        jobRunId: execution.id,
        source,
        scheduledFor,
        ...(skip ? { reason: skip } : {}),
        ...(failure ? { error: failure } : {}),
      });
      if (failure && !skip && getChannel(tx, job.channelId)?.archivedAt === null)
        createMessage(tx, {
          channelId: job.channelId,
          role: "system",
          content: `[Scheduled job: ${job.name}] Failed before execution: ${failure}`,
        });
      return { execution, run };
    });
    if (!result) return null;
    if (result.run && prepared && messages) {
      try {
        manager.start({ run: result.run, profile: prepared.profile, messages });
      } catch (error) {
        const message = redact(error instanceof Error ? error.message : "Run could not start.");
        updateRun(db, result.run.id, { status: "failed", error: message, endedAt: this.now() });
        appendRunEvent(db, {
          runId: result.run.id,
          seq: 1,
          type: "run.failed",
          payloadJson: JSON.stringify({
            runId: result.run.id,
            seq: 1,
            type: "run.failed",
            error: message,
            code: "scheduler_start_failed",
          }),
        });
        this.reconcile();
      }
    }
    return result.execution;
  }
}
