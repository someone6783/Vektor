import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireDataLock } from "../maintenance/data-lock.js";

let directory: string;
let child: ChildProcess | undefined;
let port: number;
async function start(mode: string, browserUrl?: string) {
  child = fork(fileURLToPath(new URL("./crash-server.test-utils.ts", import.meta.url)), [], {
    execArgv: ["--import", "tsx"],
    env: {
      PATH: process.env.PATH,
      NODE_ENV: "test",
      VEKTOR_DATA_DIR: directory,
      VEKTOR_WEB_DIST: join(directory, "no-web"),
      VEKTOR_ACCESS_TOKEN: "crash-test-access-token",
      TEST_CRASH_PROVIDER: mode,
      TEST_BROWSER_URL: browserUrl,
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  await new Promise<void>((resolve, reject) => {
    let stderr = "";
    child!.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child!.once("message", (message) => {
      port = (message as { port: number }).port;
      resolve();
    });
    child!.once("exit", (code) => {
      if (code) reject(new Error(stderr));
    });
    child!.once("error", reject);
  });
}
async function stop(signal: NodeJS.Signals = "SIGTERM") {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child!.once("exit", resolve));
  child.kill(signal);
  await exited;
}
async function api(path: string, body?: unknown, method?: string) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: {
      authorization: "Bearer crash-test-access-token",
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(5000),
  });
  expect(response.ok, await response.clone().text()).toBe(true);
  return response.json();
}
afterEach(async () => {
  await stop("SIGKILL");
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe("actual API process death and restart", () => {
  it("terminates managed Chromium after SIGKILL, cancels browser approval, and clears abandoned cookies on restart", async () => {
    directory = await mkdtemp(join(tmpdir(), "vektor-browser-crash-"));
    let hits = 0;
    const fixture = createServer((_request, response) => {
      hits++;
      response.end(
        '<html><body><script>document.cookie="private=ephemeral"</script><button>Submit</button></body></html>',
      );
    });
    await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
    try {
      const origin = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
      await start("browser", origin);
      const profile = (await api("/api/profiles")).profiles[0];
      await api(
        `/api/profiles/${profile.id}`,
        { browser: { mode: "interactive", allowedOrigins: [], localOrigins: [origin] } },
        "PATCH",
      );
      const channel = (await api("/api/channels", { name: "Browser crash", profileId: profile.id }))
        .channel;
      const runId = (
        await api(`/api/channels/${channel.id}/messages`, { content: "Inspect browser fixture" })
      ).run.id;
      await vi.waitFor(async () => expect((await api("/api/runtime")).approvals.length).toBe(1), {
        timeout: 10_000,
      });
      const ids = (await readFile(`/proc/${child!.pid}/task/${child!.pid}/children`, "utf8"))
        .trim()
        .split(/\s+/);
      const chromiumIds: string[] = [];
      for (const id of ids) {
        try {
          if ((await readFile(`/proc/${id}/cmdline`, "utf8")).includes("--user-data-dir="))
            chromiumIds.push(id);
        } catch {
          /* Process already exited. */
        }
      }
      expect(chromiumIds.length).toBeGreaterThan(0);
      const root = join(
        tmpdir(),
        `vektor-browser-${createHash("sha256").update(directory).digest("hex").slice(0, 20)}`,
      );
      expect((await readdir(root)).length).toBeGreaterThan(0);
      await stop("SIGKILL");
      await vi.waitFor(
        async () => {
          for (const id of chromiumIds) {
            try {
              expect((await readFile(`/proc/${id}/stat`, "utf8")).split(" ")[2]).toBe("Z");
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
          }
        },
        { timeout: 10_000 },
      );
      const before = hits;
      await start("fast");
      const recovered = await api(`/api/runs/${runId}/details`);
      expect(recovered.run.status).toBe("failed");
      expect(
        recovered.approvals.every(
          (approval: { status: string }) => approval.status === "cancelled",
        ),
      ).toBe(true);
      expect((await api(`/api/runs/${runId}/browser`)).session.active).toBe(false);
      expect(await readdir(root)).toHaveLength(0);
      expect(hits).toBe(before);
    } finally {
      fixture.closeAllConnections();
      await new Promise<void>((resolve) => fixture.close(() => resolve()));
    }
  }, 30_000);
  it("recovers streams, usage, scheduled history, approval waits and process groups without replaying commands", async () => {
    directory = await mkdtemp(join(tmpdir(), "vektor-crash-"));
    await start("hanging");
    const profile = (await api("/api/profiles")).profiles[0];
    await api(
      `/api/profiles/${profile.id}`,
      { terminalMode: "full-access", tools: ["terminal"] },
      "PATCH",
    );
    const channels = [];
    for (const name of ["Scheduled", "Tool", "Approval"])
      channels.push((await api("/api/channels", { name, profileId: profile.id })).channel);
    const job = (
      await api("/api/jobs", {
        name: "Crash job",
        profileId: profile.id,
        channelId: channels[0].id,
        prompt: "Hang after usage",
        schedule: "every minute",
        timezone: "UTC",
        enabled: false,
      })
    ).job;
    const jobRun = (await api(`/api/jobs/${job.id}/run`, {})).execution.runId;
    const toolRun = (
      await api(`/api/channels/${channels[1].id}/messages`, {
        content: "Request terminal execution",
      })
    ).run.id;
    await vi.waitFor(async () => {
      const runtime = await api("/api/runtime");
      const approval = runtime.approvals.find((item: { runId: string }) => item.runId === toolRun);
      expect(approval).toBeDefined();
      await api(`/api/approvals/${approval.id}`, { approved: true });
    });
    let commandPid = 0;
    await vi.waitFor(async () => {
      commandPid = Number(
        (await readFile(join(directory, "workspace", "child.pid"), "utf8")).trim(),
      );
      expect(commandPid).toBeGreaterThan(0);
    });
    const approvalRun = (
      await api(`/api/channels/${channels[2].id}/messages`, {
        content: "Request terminal approval",
      })
    ).run.id;
    await vi.waitFor(async () =>
      expect(
        (await api("/api/runtime")).approvals.some(
          (item: { runId: string }) => item.runId === approvalRun,
        ),
      ).toBe(true),
    );
    await vi.waitFor(async () =>
      expect((await api(`/api/runs/${jobRun}/details`)).run.usage?.costUsd).toBe(0.002),
    );
    await stop("SIGKILL");
    await vi.waitFor(
      async () => {
        try {
          const processState = await readFile(`/proc/${commandPid}/stat`, "utf8");
          expect(processState.split(" ")[2]).toBe("Z");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      },
      { timeout: 5000 },
    );
    // The OS lock is released by process death; never remove its file manually.
    await vi.waitFor(
      async () => {
        const release = await acquireDataLock(directory);
        await release();
      },
      { timeout: 14000, interval: 500 },
    );
    await start("fast");
    for (const id of [jobRun, toolRun, approvalRun]) {
      const details = await api(`/api/runs/${id}/details`);
      expect(details.run.status).toBe("failed");
      expect(details.run.error).toContain("restart");
      expect(details.run.usage.costUsd).toBe(0.002);
      expect(details.approvals.every((item: { status: string }) => item.status !== "pending")).toBe(
        true,
      );
      expect(
        details.tools.every(
          (item: { status: string }) => !["running", "waiting", "requested"].includes(item.status),
        ),
      ).toBe(true);
      const messages = (await api(`/api/channels/${details.run.channelId}/messages`)).messages;
      expect(messages.find((item: { runId: string }) => item.runId === id)).toMatchObject({
        status: "failed",
        content: expect.stringContaining("Persisted partial response"),
      });
      expect(
        details.events.filter((event: { type: string }) => event.type === "run.failed"),
      ).toHaveLength(1);
    }
    expect((await api(`/api/jobs/${job.id}/runs`)).executions[0].status).toBe("failed");
    expect((await api("/api/runtime")).activeRuns).toHaveLength(0);
    const retry = (await api(`/api/runs/${jobRun}/retry`, {})).run;
    await vi.waitFor(async () =>
      expect((await api(`/api/runs/${retry.id}/details`)).run.status).toBe("completed"),
    );
    const report = await api("/api/usage?provider=openrouter");
    const group = report.byJob.find((item: { id: string }) => item.id === job.id);
    expect(group.usage.runs).toBe(2);
    expect(group.usage.totalTokens).toBe(20);
    expect(group.usage.knownCostUsd).toBeCloseTo(0.003);
    await stop();
    await start("fast");
    expect(
      (await api(`/api/runs/${jobRun}/details`)).events.filter(
        (event: { type: string }) => event.type === "run.failed",
      ),
    ).toHaveLength(1);
    expect((await api(`/api/jobs/${job.id}/runs`)).executions).toHaveLength(1);
  }, 45000);
});
