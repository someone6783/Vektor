import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getJob, listApprovals, listJobRuns, listJobs, type JobRunRecord } from "@vektor/db";
import {
  createJobSchema,
  updateJobSchema,
  scheduleInputSchema,
  jobRunSchema,
} from "@vektor/shared";
import { type Scheduler, jobView } from "../scheduling/scheduler.js";
import { previewSchedule } from "../scheduling/schedule.js";
import { RuntimeError } from "../runtime/terminal.js";

function executionView(scheduler: Scheduler, execution: JobRunRecord) {
  return jobRunSchema.parse({
    ...execution,
    scheduledFor: execution.scheduledFor.toISOString(),
    startedAt: execution.startedAt.toISOString(),
    endedAt: execution.endedAt?.toISOString() ?? null,
    awaitingApproval:
      execution.status === "running" &&
      execution.runId !== null &&
      listApprovals(scheduler.options.db, execution.runId).some(
        (approval) => approval.status === "pending",
      ),
  });
}
export function registerJobRoutes(app: FastifyInstance, scheduler: Scheduler): void {
  const db = scheduler.options.db;
  app.post("/api/jobs/preview", async (request) => {
    const input = scheduleInputSchema.parse(request.body);
    return previewSchedule(input.schedule, input.timezone, scheduler.now());
  });
  app.get("/api/jobs", async (request) => {
    scheduler.reconcile();
    const { includeDeleted } = z
      .object({ includeDeleted: z.enum(["true", "false"]).optional() })
      .parse(request.query);
    return { jobs: listJobs(db, includeDeleted === "true").map(jobView) };
  });
  app.post("/api/jobs", async (request, reply) =>
    reply.code(201).send({ job: jobView(scheduler.create(createJobSchema.parse(request.body))) }),
  );
  app.get("/api/jobs/:jobId", async (request) => {
    const { jobId } = request.params as { jobId: string };
    const job = getJob(db, jobId);
    if (!job) throw new RuntimeError("Scheduled job not found.", 404);
    return { job: jobView(job) };
  });
  app.patch("/api/jobs/:jobId", async (request) => {
    const { jobId } = request.params as { jobId: string };
    return { job: jobView(scheduler.update(jobId, updateJobSchema.parse(request.body))) };
  });
  app.delete("/api/jobs/:jobId", async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    scheduler.remove(jobId);
    return reply.code(204).send();
  });
  app.post("/api/jobs/:jobId/run", async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    const execution = await scheduler.runNow(jobId);
    return reply.code(201).send({ execution: executionView(scheduler, execution) });
  });
  app.get("/api/jobs/:jobId/runs", async (request) => {
    const { jobId } = request.params as { jobId: string };
    if (!getJob(db, jobId)) throw new RuntimeError("Scheduled job not found.", 404);
    const query = z
      .object({ before: z.coerce.number().int().positive().optional() })
      .parse(request.query);
    scheduler.reconcile();
    const history = listJobRuns(db, jobId, query.before);
    return {
      executions: history.map((item) => executionView(scheduler, item)),
      nextBefore: history.length === 30 ? history.at(-1)!.id : null,
    };
  });
  app.get("/api/scheduler", async () => scheduler.state);
  app.post("/api/scheduler/pause", async () => {
    scheduler.pause();
    return scheduler.state;
  });
  app.post("/api/scheduler/resume", async () => {
    scheduler.resume();
    return scheduler.state;
  });
}
