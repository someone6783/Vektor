import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireSchedulerLease,
  addJobRun,
  claimJob,
  createAttachment,
  createMessage,
  createRun,
  getJob,
  listApprovals,
  listJobRuns,
  listMessages,
  listToolCalls,
  updateJob,
  type JobRecord,
} from "@vektor/db";
import { buildApp, type VektorApp } from "../app.js";
import { bootstrapStorage, type Storage } from "../bootstrap.js";
import { loadConfig, type AppConfig } from "../config.js";
import type { ChatProvider, ChatRequest } from "../providers/types.js";
import { Scheduler } from "./scheduler.js";

let app: VektorApp;
let storage: Storage;
let config: AppConfig;
let directory: string;
let now: number;
let profileId: string;
let channelId: string;
let requests: ChatRequest[];
let provider: ChatProvider;
let cleanup: Array<() => void>;
const headers = { authorization: "Bearer scheduling-test-token" };
const normalProvider: ChatProvider = {
  async *streamChat(request) {
    requests.push({ ...request, messages: structuredClone(request.messages) });
    yield { type: "text.delta", text: "Scheduled result" };
    yield { type: "usage", promptTokens: 10, completionTokens: 2, totalTokens: 12 };
    yield { type: "finish", reason: "stop" };
  },
};
async function open() {
  storage = bootstrapStorage(config);
  app = await buildApp({
    config,
    storage,
    provider,
    logger: false,
    schedulerClock: () => now,
    startScheduler: false,
  });
}
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "vektor-scheduling-"));
  now = Date.parse("2026-10-31T00:00:00Z");
  requests = [];
  cleanup = [];
  provider = normalProvider;
  config = loadConfig({
    NODE_ENV: "test",
    VEKTOR_DATA_DIR: directory,
    VEKTOR_ACCESS_TOKEN: "scheduling-test-token",
    VEKTOR_WEB_DIST: join(directory, "no-web"),
    VEKTOR_SCHEDULER_TICK_MS: "250",
  });
  await open();
  profileId = (await app.inject({ method: "GET", url: "/api/profiles", headers })).json()
    .profiles[0].id;
  channelId = (
    await app.inject({
      method: "POST",
      url: "/api/channels",
      headers,
      payload: { name: "Job delivery" },
    })
  ).json().channel.id;
});
afterEach(async () => {
  for (const release of cleanup) release();
  await app.close();
  rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});
async function create(overrides: object = {}): Promise<JobRecord> {
  const response = await app.inject({
    method: "POST",
    url: "/api/jobs",
    headers,
    payload: {
      name: "Daily summary",
      schedule: "every minute",
      timezone: "UTC",
      profileId,
      channelId,
      prompt: "Summarize the workspace",
      ...overrides,
    },
  });
  expect(response.statusCode, response.payload).toBe(201);
  return getJob(storage.db, response.json().job.id)!;
}
async function settle(job: JobRecord) {
  await vi.waitFor(
    () =>
      expect(listJobRuns(storage.db, job.id)[0]).toMatchObject({
        status: expect.stringMatching(/^(completed|failed|cancelled|skipped)$/),
      }),
    { timeout: 3000 },
  );
}
function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  cleanup.push(release);
  return { promise, release };
}
async function holdProvider() {
  await app.close();
  const waiting = gate();
  provider = {
    async *streamChat(request) {
      requests.push(request);
      await waiting.promise;
      yield { type: "text.delta", text: "Later result" };
      yield { type: "finish", reason: "stop" };
    },
  };
  await open();
  return waiting;
}

describe("durable scheduling and API", () => {
  it("executes from the actual scheduler timer without a manual tick", async () => {
    app.scheduler.start();
    const job = await create();
    now += 60_000;
    await vi.waitFor(() => expect(listJobRuns(storage.db, job.id)[0]?.status).toBe("completed"), {
      timeout: 2000,
    });
    expect(requests).toHaveLength(1);
  });

  it("retains the scheduled context policy through repeated ordinary run retries", async () => {
    createMessage(storage.db, { channelId, role: "user", content: "Private ambient history" });
    const job = await create();
    now += 60_000;
    await app.scheduler.tick();
    await settle(job);
    let runId = listJobRuns(storage.db, job.id)[0]!.runId!;
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await app.inject({ method: "POST", url: `/api/runs/${runId}/retry`, headers });
      expect(result.statusCode, result.payload).toBe(201);
      runId = result.json().run.id;
      await vi.waitFor(() =>
        expect(
          listMessages(storage.db, channelId).messages.some((message) => message.runId === runId),
        ).toBe(true),
      );
      expect(JSON.stringify(requests.at(-1)?.messages)).not.toContain("Private ambient history");
    }
  });

  it("paginates execution history by stable execution IDs", async () => {
    const job = await create();
    for (let index = 0; index < 35; index++)
      addJobRun(storage.db, {
        jobId: job.id,
        occurrenceKey: `fixture:${index}`,
        scheduledFor: new Date(now),
        source: "schedule",
        status: "skipped",
        error: "fixture",
        startedAt: new Date(now),
        endedAt: new Date(now),
      });
    const first = (
      await app.inject({ method: "GET", url: `/api/jobs/${job.id}/runs`, headers })
    ).json();
    expect(first.executions).toHaveLength(30);
    const second = (
      await app.inject({
        method: "GET",
        url: `/api/jobs/${job.id}/runs?before=${first.nextBefore}`,
        headers,
      })
    ).json();
    expect(second.executions).toHaveLength(5);
    expect(second.nextBefore).toBeNull();
    expect(new Set([...first.executions, ...second.executions].map((item) => item.id)).size).toBe(
      35,
    );
  });
  it("previews, creates, updates, pauses/resumes and soft-deletes jobs with authenticated history", async () => {
    expect((await app.inject({ method: "GET", url: "/api/jobs" })).statusCode).toBe(401);
    const preview = await app.inject({
      method: "POST",
      url: "/api/jobs/preview",
      headers,
      payload: { schedule: "weekdays at 9am", timezone: "Australia/Perth" },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().cron).toBe("0 9 * * 1-5");
    const job = await create();
    expect(job.nextRunAt?.getTime()).toBe(now + 60_000);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/jobs/${job.id}`,
          headers,
          payload: { enabled: false },
        })
      ).json().job.nextRunAt,
    ).toBeNull();
    now += 3600_000;
    await app.scheduler.tick();
    expect(requests).toHaveLength(0);
    await app.inject({
      method: "PATCH",
      url: `/api/jobs/${job.id}`,
      headers,
      payload: { enabled: true, schedule: "daily at 9am", timezone: "Australia/Perth" },
    });
    expect(getJob(storage.db, job.id)?.nextRunAt?.getTime()).toBeGreaterThan(now);
    expect(
      (await app.inject({ method: "DELETE", url: `/api/jobs/${job.id}`, headers })).statusCode,
    ).toBe(204);
    expect(
      (await app.inject({ method: "GET", url: "/api/jobs", headers })).json().jobs,
    ).toHaveLength(0);
    expect(
      (await app.inject({ method: "GET", url: "/api/jobs?includeDeleted=true", headers })).json()
        .jobs[0].deletedAt,
    ).not.toBeNull();
    expect(
      (await app.inject({ method: "GET", url: `/api/jobs/${job.id}/runs`, headers })).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/jobs",
          headers,
          payload: {
            name: "Bad",
            schedule: "unknown",
            timezone: "UTC",
            profileId,
            channelId,
            prompt: "test",
          },
        })
      ).statusCode,
    ).toBe(400);
  });

  it("fires once, delivers into the channel and excludes ambient history and attachments", async () => {
    createMessage(storage.db, { channelId, role: "user", content: "Ambient private history" });
    createAttachment(storage.db, {
      id: "private-file",
      channelId,
      filename: "secret.txt",
      mime: "text/plain",
      kind: "text",
      size: 100,
      extractedText: "Ambient private file",
      createdAt: new Date(),
      included: true,
    });
    const job = await create();
    now += 60_000;
    await app.scheduler.tick();
    await settle(job);
    await app.scheduler.tick();
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests[0]?.messages)).not.toContain("Ambient private");
    expect(
      listMessages(storage.db, channelId).messages.some((message) =>
        message.content.includes("Scheduled job: Daily summary"),
      ),
    ).toBe(true);
    expect(
      listMessages(storage.db, channelId).messages.some(
        (message) => message.content === "Scheduled result",
      ),
    ).toBe(true);
    expect(listJobRuns(storage.db, job.id)).toHaveLength(1);
    expect(listJobRuns(storage.db, job.id)[0]).toMatchObject({
      status: "completed",
      source: "schedule",
      runId: expect.any(String),
    });
    expect(getJob(storage.db, job.id)?.nextRunAt?.getTime()).toBe(now + 60_000);
  });

  it("survives restart before a future firing and does not duplicate an already completed occurrence", async () => {
    const job = await create();
    await app.close();
    now += 30_000;
    await open();
    now += 30_000;
    await app.scheduler.tick();
    await settle(job);
    expect(requests).toHaveLength(1);
    await app.close();
    await open();
    await app.scheduler.tick();
    expect(requests).toHaveLength(1);
    expect(listJobRuns(storage.db, job.id)).toHaveLength(1);
  });

  it("skips missed occurrences by default and coalesces catch-up into one attempt", async () => {
    const skipped = await create();
    const caught = await create({ name: "Catch up", catchUp: true });
    await app.close();
    now += 10 * 60_000;
    await open();
    await app.scheduler.tick();
    await settle(caught);
    expect(listJobRuns(storage.db, skipped.id)[0]).toMatchObject({
      status: "skipped",
      error: "missed",
    });
    expect(listJobRuns(storage.db, caught.id)[0]).toMatchObject({
      status: "completed",
      source: "catch-up",
    });
    expect(requests).toHaveLength(1);
    expect(getJob(storage.db, caught.id)?.nextRunAt?.getTime()).toBe(now + 60_000);
  });

  it("skips overlapping runs and other jobs targeting a busy channel", async () => {
    const waiting = await holdProvider();
    const first = await create();
    const second = await create({ name: "Other job" });
    now += 60_000;
    await app.scheduler.tick();
    expect(requests).toHaveLength(1);
    expect(
      [
        listJobRuns(storage.db, first.id)[0]?.status,
        listJobRuns(storage.db, second.id)[0]?.status,
      ].sort(),
    ).toEqual(["running", "skipped"]);
    expect([
      listJobRuns(storage.db, first.id)[0]?.error,
      listJobRuns(storage.db, second.id)[0]?.error,
    ]).toContain("channel_busy");
    now += 60_000;
    await app.scheduler.tick();
    expect(requests).toHaveLength(1);
    expect([
      listJobRuns(storage.db, first.id)[0]?.error,
      listJobRuns(storage.db, second.id)[0]?.error,
    ]).toContain("overlap");
    waiting.release();
  });

  it("prevents duplicate claims across scheduler workers and recovers expired leases", async () => {
    const job = await create();
    now += 60_000;
    acquireSchedulerLease(storage.db, "dead-worker", now);
    claimJob(storage.db, getJob(storage.db, job.id)!, "dead-worker", now);
    await app.scheduler.tick();
    expect(requests).toHaveLength(0);
    now += 31_000;
    const second = new Scheduler({ ...app.scheduler.options });
    try {
      await Promise.all([app.scheduler.tick(), second.tick()]);
      await settle(job);
      expect(requests).toHaveLength(1);
      expect(listJobRuns(storage.db, job.id)).toHaveLength(1);
    } finally {
      await second.stop();
    }
  });

  it("preserves manual run history without changing the recurrence, even while the job is paused", async () => {
    const job = await create({ enabled: false });
    const result = await app.inject({ method: "POST", url: `/api/jobs/${job.id}/run`, headers });
    expect(result.statusCode).toBe(201);
    await settle(job);
    expect(listJobRuns(storage.db, job.id)[0]?.source).toBe("manual");
    expect(getJob(storage.db, job.id)?.nextRunAt).toBeNull();
    await app.inject({ method: "DELETE", url: `/api/jobs/${job.id}`, headers });
    expect(
      (await app.inject({ method: "GET", url: `/api/jobs/${job.id}/runs`, headers })).json()
        .executions[0].status,
    ).toBe("completed");
  });

  it("records provider failures and preflight errors, and disables jobs with archived targets", async () => {
    await app.close();
    provider = {
      async *streamChat() {
        yield { type: "error", message: "Provider unavailable" };
        yield { type: "finish", reason: "error" };
      },
    };
    await open();
    const job = await create();
    now += 60_000;
    await app.scheduler.tick();
    await settle(job);
    expect(listJobRuns(storage.db, job.id)[0]).toMatchObject({
      status: "failed",
      error: "Provider unavailable",
    });
    expect(getJob(storage.db, job.id)?.enabled).toBe(true);
    expect(
      listMessages(storage.db, channelId).messages.some(
        (message) => message.role === "system" && message.content.includes("Provider unavailable"),
      ),
    ).toBe(true);
    await app.inject({ method: "DELETE", url: `/api/channels/${channelId}`, headers });
    now += 60_000;
    await app.scheduler.tick();
    expect(listJobRuns(storage.db, job.id)[0]?.status).toBe("failed");
    expect(getJob(storage.db, job.id)).toMatchObject({ enabled: false, nextRunAt: null });
  });

  it("requires explicit truncation consent for opted-in channel history", async () => {
    createMessage(storage.db, {
      channelId,
      role: "user",
      content: "large history ".repeat(10_000),
    });
    const job = await create({ includeHistory: true });
    now += 60_000;
    await app.scheduler.tick();
    expect(listJobRuns(storage.db, job.id)[0]?.status).toBe("failed");
    expect(requests).toHaveLength(0);
    await app.inject({
      method: "PATCH",
      url: `/api/jobs/${job.id}`,
      headers,
      payload: { allowTruncation: true },
    });
    now += 60_000;
    await app.scheduler.tick();
    await settle(job);
    expect(requests).toHaveLength(1);
  });

  it("does not replay paused intervals or run while the configuration is disabled", async () => {
    const job = await create({ catchUp: true });
    await app.inject({ method: "POST", url: "/api/scheduler/pause", headers });
    now += 60_000;
    await app.inject({ method: "POST", url: "/api/scheduler/resume", headers });
    await app.scheduler.tick();
    expect(listJobRuns(storage.db, job.id)[0]).toMatchObject({
      status: "skipped",
      error: "scheduler_paused",
    });
    expect(requests).toHaveLength(0);
    await app.close();
    config.schedulerEnabled = false;
    await open();
    now += 60_000;
    await app.scheduler.tick();
    expect(requests).toHaveLength(0);
    expect(
      (await app.inject({ method: "POST", url: `/api/jobs/${job.id}/run`, headers })).statusCode,
    ).toBe(423);
  });

  it("honors emergency stop across restart and does not catch up the stopped interval", async () => {
    const job = await create({ catchUp: true });
    await app.inject({ method: "POST", url: "/api/runtime/emergency-stop", headers });
    await app.close();
    now += 60_000;
    await open();
    await app.inject({ method: "POST", url: "/api/runtime/resume", headers });
    await app.scheduler.tick();
    expect(listJobRuns(storage.db, job.id)[0]).toMatchObject({
      status: "skipped",
      error: "emergency_stop",
    });
    expect(requests).toHaveLength(0);
    now += 60_000;
    await app.scheduler.tick();
    await settle(job);
    expect(requests).toHaveLength(1);
  });

  it("invalidates an in-flight preparation after pause/resume or editing the job", async () => {
    const job = await create();
    const context = app.scheduler.options.context;
    const original = context.messages.bind(context);
    const waiting = gate();
    let entered = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.spyOn(context, "messages").mockImplementationOnce(async (prepared) => {
      entered();
      await waiting.promise;
      return original(prepared);
    });
    now += 60_000;
    const tick = app.scheduler.tick();
    await started;
    await app.inject({ method: "POST", url: "/api/scheduler/pause", headers });
    await app.inject({ method: "POST", url: "/api/scheduler/resume", headers });
    waiting.release();
    await tick;
    expect(requests).toHaveLength(0);
    expect(listJobRuns(storage.db, job.id)[0]?.error).toBe("scheduler_paused");
    now += 60_000;
    const gate2 = gate();
    let entered2 = () => {};
    const start2 = new Promise<void>((resolve) => {
      entered2 = resolve;
    });
    vi.mocked(context.messages).mockImplementationOnce(async (prepared) => {
      entered2();
      await gate2.promise;
      return original(prepared);
    });
    const next = app.scheduler.tick();
    await start2;
    await app.inject({
      method: "PATCH",
      url: `/api/jobs/${job.id}`,
      headers,
      payload: { prompt: "Updated prompt" },
    });
    gate2.release();
    await next;
    expect(requests).toHaveLength(0);
    await app.scheduler.tick();
    await settle(job);
    expect(JSON.stringify(requests[0]?.messages)).toContain("Updated prompt");
  });

  it("keeps scheduled terminal approvals pending and cancels their executions on emergency stop", async () => {
    await app.close();
    provider = {
      async *streamChat() {
        yield {
          type: "tool_call",
          id: "terminal-call",
          name: "terminal",
          argumentsJson: JSON.stringify({ command: "pwd" }),
        };
        yield { type: "finish", reason: "tool_calls" };
      },
    };
    await open();
    await app.inject({
      method: "PATCH",
      url: `/api/profiles/${profileId}`,
      headers,
      payload: { terminalMode: "full-access", tools: ["terminal"] },
    });
    const job = await create();
    now += 60_000;
    await app.scheduler.tick();
    const runId = listJobRuns(storage.db, job.id)[0]!.runId!;
    await vi.waitFor(() => expect(listApprovals(storage.db, runId)[0]?.status).toBe("pending"));
    expect(listToolCalls(storage.db, runId)[0]?.status).toBe("waiting");
    expect(
      (await app.inject({ method: "GET", url: `/api/jobs/${job.id}/runs`, headers })).json()
        .executions[0].awaitingApproval,
    ).toBe(true);
    await app.inject({ method: "POST", url: "/api/runtime/emergency-stop", headers });
    expect(listJobRuns(storage.db, job.id)[0]?.status).toBe("cancelled");
    expect(listApprovals(storage.db, runId)[0]?.status).toBe("cancelled");
  });

  it("marks an interrupted committed dispatch failed on restart without replay", async () => {
    const job = await create();
    now += 60_000;
    const message = createMessage(storage.db, {
      channelId,
      role: "user",
      content: "Committed before crash",
    });
    const run = createRun(storage.db, {
      channelId,
      profileId,
      userMessageId: message.id,
      model: "test",
    });
    addJobRun(storage.db, {
      jobId: job.id,
      runId: run.id,
      occurrenceKey: `scheduled:${now}`,
      scheduledFor: new Date(now),
      source: "schedule",
      status: "running",
      startedAt: new Date(now),
    });
    updateJob(storage.db, job.id, { nextRunAt: new Date(now + 60_000) }, now);
    await app.close();
    now += 1000;
    await open();
    await app.scheduler.tick();
    expect(listJobRuns(storage.db, job.id)[0]).toMatchObject({
      status: "failed",
      error: expect.stringContaining("restart"),
    });
    expect(requests).toHaveLength(0);
  });
});
