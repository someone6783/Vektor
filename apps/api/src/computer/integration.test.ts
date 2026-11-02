import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getApproval, getRun, listToolCalls, saveComputerArtifact, setSetting } from "@vektor/db";
import type { ComputerState, ComputerInput } from "@vektor/shared";
import { bootstrapStorage, type Storage } from "../bootstrap.js";
import { loadConfig } from "../config.js";
import { buildApp, type VektorApp } from "../app.js";
import type { ChatProvider } from "../providers/types.js";
import type { ComputerController, ComputerSessionOptions } from "./controller.js";
import { RuntimeError } from "../runtime/terminal.js";

let app: VektorApp;
let storage: Storage;
let directory: string;
let profileId: string;
let channelId: string;
let seenImages: number;
let batchScreenshots: boolean;
let requestRoles: string[][];
let sessions: Array<{
  execute: (input: ComputerInput) => Promise<Record<string, unknown>>;
  close: () => Promise<void>;
}>;
const headers = { authorization: "Bearer phase10-api-access-token" };

function fakeController(options: ComputerSessionOptions): ComputerController {
  const state: ComputerState = {
    active: true,
    paused: false,
    sensitive: false,
    phase: "active",
    mode: "control",
    session: "isolated",
    width: 800,
    height: 600,
    app: "Message",
    windows: [{ id: "42", title: "Phase 10 test" }],
    cursor: { x: 0, y: 0 },
    actions: 1,
  };
  const session = {
    execute: vi.fn(async (input: ComputerInput, human = false) => {
      if (state.sensitive && !human) throw new RuntimeError("Private takeover active.", 409);
      if (input.action === "click" && !human) {
        if (options.permissions().mode !== "control")
          throw new RuntimeError("Computer access is observation only for this profile.", 403);
        const approved = await options.approve(
          `Click the isolated desktop at ${input.x},${input.y}.`,
          async () => true,
        );
        if (!approved) throw new RuntimeError("The user denied this desktop action.", 403);
      }
      return { untrusted: true, phase: "active", action: input.action };
    }),
    state: () => state,
    screenshot: vi.fn(async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9])),
    privateTakeover: vi.fn(() => {
      state.sensitive = true;
      state.paused = true;
      state.windows = [];
    }),
    pause: vi.fn((paused: boolean) => {
      if (!paused && state.sensitive)
        throw new RuntimeError("Close the private desktop before resuming.", 409);
      state.paused = paused;
    }),
    close: vi.fn(async () => undefined),
  };
  sessions.push({ execute: session.execute, close: session.close });
  return session;
}

beforeEach(async () => {
  seenImages = 0;
  batchScreenshots = false;
  requestRoles = [];
  sessions = [];
  directory = mkdtempSync(join(tmpdir(), "vektor-computer-api-"));
  const config = loadConfig({
    NODE_ENV: "test",
    VEKTOR_DATA_DIR: directory,
    VEKTOR_ACCESS_TOKEN: "phase10-api-access-token",
    VEKTOR_WEB_DIST: join(directory, "missing-web"),
  });
  storage = bootstrapStorage(config);
  const provider: ChatProvider = {
    async *streamChat(request) {
      requestRoles.push(request.messages.map((message) => message.role));
      if (request.messages.some((message) => Array.isArray(message.content))) seenImages += 1;
      const results = request.messages.filter((message) => message.role === "tool");
      if (results.length === 0) {
        yield {
          type: "tool_call",
          id: "computer-shot",
          name: "computer",
          argumentsJson: JSON.stringify({ action: "screenshot" }),
        };
        if (batchScreenshots)
          yield {
            type: "tool_call",
            id: "computer-windows",
            name: "computer",
            argumentsJson: JSON.stringify({ action: "windows" }),
          };
        yield { type: "finish", reason: "tool_calls" };
        return;
      }
      if (results.length === 1) {
        yield {
          type: "tool_call",
          id: "computer-click",
          name: "computer",
          argumentsJson: JSON.stringify({ action: "click", x: 20, y: 30 }),
        };
        yield { type: "finish", reason: "tool_calls" };
        return;
      }
      yield { type: "text.delta", text: "Controlled desktop reviewed." };
      yield { type: "finish", reason: "stop" };
    },
  };
  app = await buildApp({
    config,
    storage,
    logger: false,
    provider,
    startScheduler: false,
    computerFactory: (options: ComputerSessionOptions) => fakeController(options),
    computerCapabilities: { available: true, reason: null, location: "backend-isolated" },
  });
  profileId = (await app.inject({ url: "/api/profiles", headers })).json().profiles[0].id;
  channelId = (
    await app.inject({
      url: "/api/channels",
      method: "POST",
      headers,
      payload: { name: "Computer test", profileId },
    })
  ).json().channel.id;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await app.close();
  rmSync(directory, { recursive: true, force: true });
});

async function enable(mode: "off" | "observe" | "control" = "control") {
  const response = await app.inject({
    url: `/api/profiles/${profileId}`,
    method: "PATCH",
    headers,
    payload: {
      computer: {
        mode,
        width: 800,
        height: 600,
        apps: [{ name: "Message", command: "/usr/bin/xmessage", args: ["Phase 10 test"] }],
      },
    },
  });
  expect(response.statusCode).toBe(200);
  expect(response.json().profile.computer.mode).toBe(mode);
}
async function start() {
  const response = await app.inject({
    url: `/api/channels/${channelId}/messages`,
    method: "POST",
    headers,
    payload: { content: "Inspect the isolated desktop." },
  });
  expect(response.statusCode).toBe(201);
  return response.json().run.id as string;
}
async function pending() {
  let approval!: { id: string; command: string };
  await vi.waitFor(
    async () => {
      approval = (await app.inject({ url: "/api/runtime", headers })).json().approvals[0];
      expect(approval).toBeDefined();
    },
    { timeout: 10_000 },
  );
  return approval;
}

describe("isolated computer API", () => {
  it("requires authentication and reports backend capabilities", async () => {
    expect((await app.inject({ url: "/api/computer/capabilities" })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/computer/capabilities", headers })).json()).toMatchObject(
      { available: true, location: "backend-isolated" },
    );
  });

  it("rejects models known to lack image or tool support before opening a desktop", async () => {
    await enable();
    for (const support of [
      { supportsImages: false, supportsTools: true },
      { supportsImages: true, supportsTools: false },
    ]) {
      setSetting(storage.db, "provider.openrouter.models", {
        fetchedAt: Date.now(),
        models: [{ id: "openrouter/auto", name: "Test", ...support }],
      });
      const runId = await start();
      await vi.waitFor(() => expect(getRun(storage.db, runId)?.status).toBe("failed"));
      expect(getRun(storage.db, runId)?.error).toMatch(/does not (accept image|support tool)/);
      expect(sessions).toHaveLength(0);
    }
  });

  it("captures a model-visible screenshot and approves a click", async () => {
    await enable();
    const runId = await start();
    const approval = await pending();
    expect(approval.command).toContain("Click the isolated desktop");
    const state = (await app.inject({ url: `/api/runs/${runId}/computer`, headers })).json()
      .session;
    expect(state).toMatchObject({ mode: "control", width: 800, height: 600, app: "Message" });
    const screenshot = await app.inject({
      url: `/api/runs/${runId}/computer/screenshot`,
      headers,
    });
    expect(screenshot.statusCode).toBe(200);
    expect(screenshot.headers["content-type"]).toBe("image/jpeg");

    const decided = await app.inject({
      url: `/api/approvals/${approval.id}`,
      method: "POST",
      headers,
      payload: { approved: true },
    });
    expect(decided.statusCode).toBe(200);
    await vi.waitFor(() => expect(getRun(storage.db, runId)?.status).toBe("completed"), {
      timeout: 10_000,
    });
    expect(seenImages).toBeGreaterThan(0);
    expect(listToolCalls(storage.db, runId).map((tool) => tool.name)).toEqual([
      "computer",
      "computer",
      "computer.approval",
    ]);
    expect(sessions).toHaveLength(1);
  }, 30_000);

  it("returns every batched tool result before adding screenshot images to context", async () => {
    batchScreenshots = true;
    await enable("observe");
    const runId = await start();
    await vi.waitFor(() => expect(getRun(storage.db, runId)?.status).toBe("completed"));
    expect(seenImages).toBeGreaterThan(0);
    expect(requestRoles.at(-1)?.slice(-4)).toEqual(["assistant", "tool", "tool", "user"]);
  });

  it("rejects control actions for observation-only profiles", async () => {
    await enable("observe");
    const runId = await start();
    await vi.waitFor(() => expect(getRun(storage.db, runId)?.status).toBe("completed"), {
      timeout: 10_000,
    });
    const calls = listToolCalls(storage.db, runId);
    expect(calls[1]).toMatchObject({ name: "computer", status: "denied" });
    expect(calls[1]?.output).toMatch(/observation only/);
  }, 30_000);

  it("revokes the desktop and pending approval after a profile permission change", async () => {
    await enable();
    const runId = await start();
    const approval = await pending();
    await enable("off");
    expect(getApproval(storage.db, approval.id)?.status).toBe("cancelled");
    expect(sessions[0]?.close).toHaveBeenCalled();
    const input = await app.inject({
      url: `/api/runs/${runId}/computer/input`,
      method: "POST",
      headers,
      payload: { action: "screenshot" },
    });
    expect(input.statusCode).toBe(409);
  });

  it("enters private takeover before manual text and blocks Resume until the desktop closes", async () => {
    await enable();
    const runId = await start();
    const approval = await pending();
    const typed = await app.inject({
      url: `/api/runs/${runId}/computer/input`,
      method: "POST",
      headers,
      payload: { action: "type", text: "private-fixture-value" },
    });
    expect(typed.statusCode).toBe(200);
    expect(getApproval(storage.db, approval.id)?.status).toBe("cancelled");
    expect(
      (await app.inject({ url: `/api/runs/${runId}/computer`, headers })).json().session.sensitive,
    ).toBe(true);
    const resumed = await app.inject({
      url: `/api/runs/${runId}/computer/control`,
      method: "POST",
      headers,
      payload: { action: "resume" },
    });
    expect(resumed.statusCode).toBe(409);
    const audit = storage.sqlite.prepare("select * from audit_log where run_id = ?").all(runId);
    expect(JSON.stringify(audit)).not.toContain("private-fixture-value");
    await app.inject({
      url: `/api/runs/${runId}/computer/control`,
      method: "POST",
      headers,
      payload: { action: "close" },
    });
    await vi.waitFor(() => expect(getRun(storage.db, runId)?.status).toBe("completed"));
  });

  it("authenticates action artifacts, lists metadata only, and deletes their images", async () => {
    await enable();
    const runId = await start();
    await pending();
    const id = saveComputerArtifact(
      storage.db,
      runId,
      "action",
      "click",
      "before",
      Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      10000,
    )!;
    expect((await app.inject({ url: `/api/computer-artifacts/${id}` })).statusCode).toBe(401);
    const files = (await app.inject({ url: `/api/runs/${runId}/computer`, headers })).json()
      .artifacts;
    expect(files[0]).toMatchObject({ id, stage: "before", action: "click" });
    expect(files[0]).not.toHaveProperty("jpeg");
    const image = await app.inject({ url: `/api/computer-artifacts/${id}`, headers });
    expect(image.statusCode).toBe(200);
    expect(image.headers["cache-control"]).toBe("no-store");
    expect(
      (
        await app.inject({
          url: `/api/runs/${runId}/computer/artifacts`,
          method: "DELETE",
          headers,
        })
      ).statusCode,
    ).toBe(204);
    expect((await app.inject({ url: `/api/computer-artifacts/${id}`, headers })).statusCode).toBe(
      404,
    );
  });

  it("requires explicit scheduled computer access and retains interactive approvals", async () => {
    await enable();
    const makeJob = async (computerAccess: "off" | "observe" | "control") => {
      const result = await app.inject({
        url: "/api/jobs",
        method: "POST",
        headers,
        payload: {
          name: "Computer",
          profileId,
          channelId,
          prompt: "Inspect desktop",
          schedule: "every minute",
          timezone: "UTC",
          enabled: false,
          computerAccess,
        },
      });
      expect(result.statusCode).toBe(201);
      return result.json().job;
    };
    const off = await makeJob("off");
    let response = await app.inject({
      url: `/api/jobs/${off.id}/run`,
      method: "POST",
      headers,
      payload: {},
    });
    let runId = response.json().execution.runId;
    await vi.waitFor(() => expect(getRun(storage.db, runId)?.status).toBe("completed"));
    expect(sessions).toHaveLength(0);
    const controlled = await makeJob("control");
    response = await app.inject({
      url: `/api/jobs/${controlled.id}/run`,
      method: "POST",
      headers,
      payload: {},
    });
    runId = response.json().execution.runId;
    const approval = await pending();
    expect(getRun(storage.db, runId)?.status).toBe("running");
    expect(sessions).toHaveLength(1);
    await app.inject({
      url: `/api/approvals/${approval.id}`,
      method: "POST",
      headers,
      payload: { approved: false },
    });
    await vi.waitFor(() => expect(getRun(storage.db, runId)?.status).toBe("completed"));
    const revocable = await makeJob("control");
    response = await app.inject({
      url: `/api/jobs/${revocable.id}/run`,
      method: "POST",
      headers,
      payload: {},
    });
    runId = response.json().execution.runId;
    const revoked = await pending();
    await app.inject({
      url: `/api/jobs/${revocable.id}`,
      method: "PATCH",
      headers,
      payload: { computerAccess: "off" },
    });
    expect(getApproval(storage.db, revoked.id)?.status).toBe("cancelled");
    expect(sessions.at(-1)?.close).toHaveBeenCalled();
    await vi.waitFor(() => expect(getRun(storage.db, runId)?.status).toBe("completed"));
    await enable("observe");
    const exceeded = await app.inject({
      url: "/api/jobs",
      method: "POST",
      headers,
      payload: {
        name: "Invalid",
        profileId,
        channelId,
        prompt: "Desktop",
        schedule: "every minute",
        timezone: "UTC",
        enabled: false,
        computerAccess: "control",
      },
    });
    expect(exceeded.statusCode).toBe(403);
  });

  it("closes the desktop on request and refuses to reopen it in the same run", async () => {
    await enable();
    const runId = await start();
    const approval = await pending();
    const closed = await app.inject({
      url: `/api/runs/${runId}/computer/control`,
      method: "POST",
      headers,
      payload: { action: "close" },
    });
    expect(closed.statusCode).toBe(200);
    await vi.waitFor(() => {
      expect(getApproval(storage.db, approval.id)?.status).toBe("cancelled");
    });
    const reopened = await app.inject({
      url: `/api/runs/${runId}/computer/input`,
      method: "POST",
      headers,
      payload: { action: "screenshot" },
    });
    expect(reopened.statusCode).toBe(409);
  }, 30_000);

  it("closes the desktop on emergency stop and refuses a denied click", async () => {
    await enable();
    const runId = await start();
    const approval = await pending();
    const paused = await app.inject({
      url: `/api/runs/${runId}/computer/control`,
      method: "POST",
      headers,
      payload: { action: "pause" },
    });
    expect(paused.statusCode).toBe(200);
    await vi.waitFor(() => {
      expect(getApproval(storage.db, approval.id)?.status).toBe("cancelled");
    });
    await app.inject({
      url: "/api/runtime/emergency-stop",
      method: "POST",
      headers,
    });
    await vi.waitFor(() => expect(sessions[0]?.close).toHaveBeenCalled(), { timeout: 5000 });
    const denied = await app.inject({
      url: `/api/approvals/${approval.id}`,
      method: "POST",
      headers,
      payload: { approved: false },
    });
    expect(denied.statusCode).toBe(409);
  }, 30_000);
});
