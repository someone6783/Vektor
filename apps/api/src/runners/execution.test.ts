import * as native from "./native.js";
import { HarnessSnapshots } from "./snapshots.js";
import { RunnerInstallations } from "./installations.js";
import { spawnSync } from "node:child_process";
import { BrowserNetwork } from "../browser/network.js";
import { runnerSetupSchema } from "@vektor/shared";
import { fakeCodex, fakeAcp } from "./fixtures.test-utils.js";
import { AgentCatalog, registryEntrySchema } from "./catalog.js";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import { bootstrapStorage, type Storage } from "../bootstrap.js";
import { loadConfig } from "../config.js";
import {
  setSetting,
  getRun,
  listApprovals,
  getSetting,
  listMessages,
  listRunEvents,
} from "@vektor/db";
import { encryptSecret } from "../secrets.js";
import type { FastifyInstance } from "fastify";

// This agent really runs inside Bubblewrap, with the same broker and process
// supervision used by production runners. It never calls a paid model endpoint.

let app: FastifyInstance;
let storage: Storage;
let directory: string;
let profileId: string;
let channelId: string;
let nativeRequests = 0;
const headers = { authorization: "Bearer external-runner-test-token" };
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "vektor-external-"));
  const config = loadConfig({
    NODE_ENV: "test",
    VEKTOR_DATA_DIR: directory,
    VEKTOR_ACCESS_TOKEN: "external-runner-test-token",
    VEKTOR_WEB_DIST: join(directory, "no-web"),
  });
  storage = bootstrapStorage(config);
  nativeRequests = 0;
  app = await buildApp({
    config,
    storage,
    logger: false,
    startScheduler: false,
    provider: {
      kind: "stub",
      async *streamChat() {
        nativeRequests++;
        yield { type: "text.delta", text: "Native still works." };
        yield { type: "finish", reason: "stop" };
      },
    },
  });
  profileId = (await app.inject({ method: "GET", url: "/api/profiles", headers })).json()
    .profiles[0].id;
  await app.inject({
    method: "PATCH",
    url: `/api/profiles/${profileId}`,
    headers,
    payload: {
      runner: "codex",
      model: "test-model",
      terminalMode: "full-access",
      tools: ["terminal"],
    },
  });
  channelId = (
    await app.inject({
      method: "POST",
      url: "/api/channels",
      headers,
      payload: { name: "External", profileId },
    })
  ).json().channel.id;
  const command = join(directory, "agent.py");
  writeFileSync(command, fakeCodex, { mode: 0o700 });
  setSetting(storage.db, "runner.installations", [
    {
      id: "codex",
      name: "Codex fixture",
      interface: "codex-app-server",
      version: "0.166.0",
      command,
      args: [],
      executableHash: createHash("sha256").update(fakeCodex).digest("hex"),
      source: "test-fixture",
      sourceHash: "fixture",
      verifiedAt: new Date().toISOString(),
      enabled: true,
      inferenceHosts: ["api.openai.com"],
      credentialName: "OPENAI_API_KEY",
    },
  ]);
  setSetting(storage.db, `runner.grant.${profileId}`, {
    runner: "codex",
    workspace: true,
    inference: true,
  });
  setSetting(
    storage.db,
    "runner.credentials.codex",
    encryptSecret("external-dummy-secret", storage.secretsKey),
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  await app.close();
  rmSync(directory, { recursive: true, force: true });
});
async function send(content = "Write the file", extra: Record<string, unknown> = {}) {
  const response = await app.inject({
    method: "POST",
    url: `/api/channels/${channelId}/messages`,
    headers,
    payload: { content, ...extra },
  });
  expect(response.statusCode).toBe(201);
  return response.json().run.id as string;
}
async function approval(runId: string) {
  await vi.waitFor(
    () =>
      expect(listApprovals(storage.db, runId).filter((a) => a.status === "pending")).toHaveLength(
        1,
      ),
    { timeout: 10000 },
  );
  return listApprovals(storage.db, runId).find((a) => a.status === "pending")!;
}
async function finish(runId: string, status = "completed") {
  await vi.waitFor(() => expect(getRun(storage.db, runId)?.status).toBe(status), {
    timeout: 10000,
  });
}
describe("isolated external execution through the real API", () => {
  it("requires a human file approval, persists session identifiers and resumes only on explicit action", async () => {
    const id = await send();
    const pending = await approval(id);
    expect(existsSync(join(directory, "workspace/hello.txt"))).toBe(false);
    await app.inject({
      method: "POST",
      url: `/api/approvals/${pending.id}`,
      headers,
      payload: { approved: true },
    });
    await finish(id);
    expect(readFileSync(join(directory, "workspace/hello.txt"), "utf8")).toBe(
      "Human approved content",
    );
    expect(getRun(storage.db, id)?.harness).toMatchObject({
      sessionId: "thread",
      turnId: "turn",
      interface: "codex-app-server",
      state: "completed",
    });
    const resumed = await send("ISOLATION", { resumeFromRunId: id });
    await finish(resumed);
    expect(
      listMessages(storage.db, channelId).messages.some(
        (m) => m.runId === resumed && m.content === "ISOLATED",
      ),
    ).toBe(true);
    expect(getRun(storage.db, resumed)?.harness).toMatchObject({ resumeFromRunId: id });
  });
  it("denial prevents real file changes", async () => {
    const id = await send();
    const pending = await approval(id);
    await app.inject({
      method: "POST",
      url: `/api/approvals/${pending.id}`,
      headers,
      payload: { approved: false },
    });
    await finish(id);
    expect(existsSync(join(directory, "workspace/hello.txt"))).toBe(false);
  });
  it("emergency stop cancels the agent and approval and preserves the stop latch", async () => {
    const id = await send();
    await approval(id);
    await app.inject({ method: "POST", url: "/api/runtime/emergency-stop", headers });
    await finish(id, "cancelled");
    expect(listApprovals(storage.db, id)[0]?.status).toBe("cancelled");
    expect(getSetting(storage.db, "runtime.emergencyStopped")).toBe(true);
    expect(existsSync(join(directory, "workspace/hello.txt"))).toBe(false);
  });
  it("pauses scheduled external work for approval and cancels its durable job history on emergency stop", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/jobs",
      headers,
      payload: {
        name: "External schedule",
        profileId,
        channelId,
        prompt: "Write a reviewed file",
        schedule: "0 * * * *",
        timezone: "UTC",
        enabled: false,
      },
    });
    expect(created.statusCode).toBe(201);
    const jobId = created.json().job.id as string;
    const started = await app.inject({ method: "POST", url: `/api/jobs/${jobId}/run`, headers });
    expect(started.statusCode).toBe(201);
    const runId = started.json().execution.runId as string;
    await approval(runId);
    const history = await app.inject({ method: "GET", url: `/api/jobs/${jobId}/runs`, headers });
    expect(history.json().executions[0].awaitingApproval).toBe(true);
    await app.inject({ method: "POST", url: "/api/runtime/emergency-stop", headers });
    await finish(runId, "cancelled");
    const stopped = await app.inject({ method: "GET", url: `/api/jobs/${jobId}/runs`, headers });
    expect(stopped.json().executions[0].status).toBe("cancelled");
    expect(existsSync(join(directory, "workspace/hello.txt"))).toBe(false);
  });
  it("revokes profile grants and refuses a stale approval without executing it", async () => {
    const id = await send();
    const pending = await approval(id);
    const revoked = await app.inject({
      method: "PUT",
      url: `/api/profiles/${profileId}/runner-grant`,
      headers,
      payload: { workspace: false, inference: true },
    });
    expect(revoked.statusCode).toBe(200);
    await finish(id, "cancelled");
    const stale = await app.inject({
      method: "POST",
      url: `/api/approvals/${pending.id}`,
      headers,
      payload: { approved: true },
    });
    expect(stale.statusCode).toBe(409);
    expect(existsSync(join(directory, "workspace/hello.txt"))).toBe(false);
  });
  it("backs off after a crashed connection and retries only after explicit setup action", async () => {
    const id = await send("CRASH");
    await finish(id, "failed");
    const retry = await app.inject({
      method: "POST",
      url: `/api/channels/${channelId}/messages`,
      headers,
      payload: { content: "This must not automatically restart" },
    });
    expect(retry.statusCode).toBe(409);
    expect(retry.payload).toContain("Reconnect explicitly");
    expect(nativeRequests).toBe(0);
    await app.inject({
      method: "PUT",
      url: "/api/runners/installations/codex/credential",
      headers,
      payload: { key: "explicit-renewed-dummy-key" },
    });
    const next = await send("ISOLATION");
    await finish(next);
    expect(
      listMessages(storage.db, channelId).messages.filter((message) => message.role === "user"),
    ).toHaveLength(2);
  });
  it("rejects unsupported modes and never falls back to native", async () => {
    await app.inject({
      method: "PATCH",
      url: `/api/profiles/${profileId}`,
      headers,
      payload: { terminalMode: "basic" },
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/channels/${channelId}/messages`,
      headers,
      payload: { content: "Hello" },
    });
    expect(response.statusCode).toBe(409);
    expect(listMessages(storage.db, channelId).messages).toHaveLength(0);
  });
  it("keeps credentials write-only and encrypted and labels setup state separately", async () => {
    const response = await app.inject({ method: "GET", url: "/api/runners", headers });
    expect(response.payload).not.toContain("external-dummy-secret");
    expect(getSetting(storage.db, "runner.credentials.codex")).not.toContain(
      "external-dummy-secret",
    );
    const id = await send("ISOLATION");
    await finish(id);
    expect(
      listRunEvents(storage.db, id)
        .map((e) => e.payloadJson)
        .join(""),
    ).not.toContain("external-dummy-secret");
  });
});

async function acpFixture() {
  const id = "acp:fixture-agent";
  const command = join(directory, "acp-agent.py");
  writeFileSync(command, fakeAcp, { mode: 0o700 });
  const entry = {
    id: "fixture-agent",
    name: "Fixture ACP",
    version: "1.0.0",
    description: "Controlled protocol fixture",
    authors: ["Vektor tests"],
    license: "MIT",
    distribution: {
      binary: {
        "linux-x86_64": {
          archive: "https://example.com/fixture.tar.gz",
          cmd: "./agent",
          sha256: "0".repeat(64),
        },
      },
    },
  };
  const verifiedEntry = registryEntrySchema.parse(entry);
  setSetting(storage.db, "runner.registry.snapshot", {
    source: "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json",
    checkedAt: new Date().toISOString(),
    hash: "0".repeat(64),
    agents: [verifiedEntry],
  });
  const current = getSetting(storage.db, "runner.installations") as unknown[];
  setSetting(storage.db, "runner.installations", [
    ...current,
    {
      id,
      name: "Fixture ACP",
      interface: "acp-v1",
      version: "1.0.0",
      command,
      args: [],
      executableHash: createHash("sha256").update(fakeAcp).digest("hex"),
      source: "fixture",
      sourceHash: createHash("sha256").update(JSON.stringify(verifiedEntry)).digest("hex"),
      verifiedAt: new Date().toISOString(),
      enabled: true,
      inferenceHosts: ["api.anthropic.com"],
      credentialName: "ANTHROPIC_API_KEY",
    },
  ]);
  setSetting(
    storage.db,
    `runner.credentials.${id}`,
    encryptSecret("acp-dummy-secret", storage.secretsKey),
  );
  await app.inject({
    method: "PATCH",
    url: `/api/profiles/${profileId}`,
    headers,
    payload: { runner: id, model: "agent-default" },
  });
  setSetting(storage.db, `runner.grant.${profileId}`, {
    runner: id,
    workspace: true,
    inference: true,
  });
}
describe("ACP agents use the same Vektor execution gate", () => {
  it.each(["verified-acp", "opencode", "opencode-native", "opencode-free"])(
    "verifies, enables and executes %s through the complete setup flow",
    async (registryId) => {
      const freeModels = registryId === "opencode-free";
      const nativeConnection = registryId === "opencode-native" || freeModels;
      if (nativeConnection) registryId = "opencode";
      const args = registryId === "opencode" ? ["acp"] : [];
      const credentialName = registryId === "opencode" ? "OPENROUTER_API_KEY" : "ANTHROPIC_API_KEY";
      const host = registryId === "opencode" ? "openrouter.ai" : "api.anthropic.com";
      const command = join(directory, "verified-acp.py");
      writeFileSync(command, fakeAcp, { mode: 0o700 });
      const archive = spawnSync("/usr/bin/tar", [
        "-czf",
        "-",
        "-C",
        directory,
        "./verified-acp.py",
      ]);
      expect(archive.status).toBe(0);
      const entry = registryEntrySchema.parse({
        id: registryId,
        name: registryId === "opencode" ? "OpenCode" : "Verified fixture ACP",
        version: "1.0.0",
        description: "Controlled ACP conformance agent",
        authors: ["Vektor tests"],
        license: "MIT",
        repository: "https://example.com/acp",
        distribution: {
          binary: {
            [process.arch === "arm64" ? "linux-aarch64" : "linux-x86_64"]: {
              archive: "https://example.com/agent.tar.gz",
              cmd: "./verified-acp.py",
              args,
              sha256: createHash("sha256").update(archive.stdout).digest("hex"),
            },
          },
        },
      });
      setSetting(storage.db, "runner.registry.snapshot", {
        source: "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json",
        checkedAt: new Date().toISOString(),
        hash: "0".repeat(64),
        agents: [entry],
      });
      const probe = await app.inject({
        method: "POST",
        url: "/api/runners/probe",
        headers,
        payload: { interface: "acp-v1", command, args },
      });
      expect(probe.statusCode).toBe(200);
      vi.spyOn(BrowserNetwork.prototype, "request").mockResolvedValue({
        status: 200,
        headers: {},
        body: archive.stdout,
      });
      if (nativeConnection) {
        vi.spyOn(native, "discoverNativeRunners").mockResolvedValue([
          { name: "opencode", command },
        ]);
        vi.spyOn(native, "readNativeAccount").mockResolvedValue({
          runner: "opencode",
          auth: freeModels ? {} : { anthropic: { type: "api", key: "native-anthropic-fixture" } },
          hosts: freeModels ? ["opencode.ai"] : ["api.anthropic.com"],
        });
        vi.spyOn(AgentCatalog.prototype, "sync").mockImplementation(async function (
          this: AgentCatalog,
        ) {
          return this.snapshot()!;
        });
        const connected = await app.inject({
          method: "POST",
          url: "/api/runners/connect",
          headers,
          payload: { runner: "opencode" },
        });
        expect(connected.statusCode, connected.payload).toBe(200);
        expect(connected.json()).toEqual({ connected: true });
      } else {
        const configured = await app.inject({
          method: "POST",
          url: "/api/runners/installations",
          headers,
          payload: {
            id: `acp:${registryId}`,
            executableHash: probe.json().executableHash,
            inferenceHosts: [host],
            credentialName,
          },
        });
        expect(configured.statusCode, configured.payload).toBe(201);
        expect(configured.json().installation.enabled).toBe(false);
        expect(
          (
            await app.inject({
              method: "PUT",
              url: `/api/runners/installations/acp%3A${registryId}/credential`,
              headers,
              payload: { key: "verified-acp-test-key" },
            })
          ).statusCode,
        ).toBe(200);
        expect(
          (
            await app.inject({
              method: "PATCH",
              url: `/api/runners/installations/acp%3A${registryId}`,
              headers,
              payload: { enabled: true },
            })
          ).statusCode,
        ).toBe(200);
      }
      expect(
        (
          await app.inject({
            method: "PUT",
            url: `/api/profiles/${profileId}/runner-grant`,
            headers,
            payload: { runner: `acp:${registryId}`, workspace: true, inference: true },
          })
        ).statusCode,
      ).toBe(200);
      await app.inject({
        method: "PATCH",
        url: `/api/profiles/${profileId}`,
        headers,
        payload: { runner: `acp:${registryId}`, model: "agent-default" },
      });
      const setup = runnerSetupSchema.parse(
        (await app.inject({ method: "GET", url: "/api/runners", headers })).json(),
      );
      expect(setup.installations.find((agent) => agent.id === `acp:${registryId}`)).toMatchObject({
        enabled: true,
        credentialConfigured: true,
        source: "https://example.com/acp",
        executableHash: probe.json().executableHash,
      });
      const id = await send("STAGED");
      const pending = await approval(id);
      await app.inject({
        method: "POST",
        url: `/api/approvals/${pending.id}`,
        headers,
        payload: { approved: true },
      });
      await finish(id);
      expect(readFileSync(join(directory, "workspace/staged.txt"), "utf8")).toBe(
        "Proposed staged content",
      );
    },
  );

  it("streams an ACP task, approves client file writes and records its real interface", async () => {
    await acpFixture();
    const id = await send();
    const pending = await approval(id);
    expect(existsSync(join(directory, "workspace/acp-approved.txt"))).toBe(false);
    await app.inject({
      method: "POST",
      url: `/api/approvals/${pending.id}`,
      headers,
      payload: { approved: true },
    });
    await finish(id);
    expect(readFileSync(join(directory, "workspace/acp-approved.txt"), "utf8")).toBe(
      "ACP approved content",
    );
    expect(getRun(storage.db, id)?.harness).toMatchObject({
      interface: "acp-v1",
      sessionId: "acp-session",
      metricsAvailable: false,
    });
    expect(getRun(storage.db, id)?.usage).toBeNull();
  });
  it("bridges ACP terminal lifecycle through Vektor approval and command execution", async () => {
    await acpFixture();
    const id = await send("TERMINAL");
    const pending = await approval(id);
    expect(existsSync(join(directory, "workspace/terminal-approved.txt"))).toBe(false);
    await app.inject({
      method: "POST",
      url: `/api/approvals/${pending.id}`,
      headers,
      payload: { approved: true },
    });
    await finish(id);
    expect(existsSync(join(directory, "workspace/terminal-approved.txt"))).toBe(true);
  });
  it("denies unknown permission kinds and out-of-scope filesystem requests", async () => {
    await acpFixture();
    const unknown = await send("UNKNOWN_PERMISSION");
    await finish(unknown);
    expect(listApprovals(storage.db, unknown)).toHaveLength(0);
    expect(
      listMessages(storage.db, channelId).messages.find((m) => m.runId === unknown)?.content,
    ).toContain("cancelled");
    const outside = await send("OUTSIDE");
    await finish(outside);
    expect(listApprovals(storage.db, outside)).toHaveLength(0);
    expect(existsSync("/etc/outside")).toBe(false);
  });
  it("reviews an agent's own staged edits before applying them to the real workspace", async () => {
    await acpFixture();
    const id = await send("STAGED");
    const pending = await approval(id);
    expect(pending.command).toContain("Proposed staged content");
    expect(existsSync(join(directory, "workspace/staged.txt"))).toBe(false);
    await app.inject({
      method: "POST",
      url: `/api/approvals/${pending.id}`,
      headers,
      payload: { approved: true },
    });
    await finish(id);
    expect(readFileSync(join(directory, "workspace/staged.txt"), "utf8")).toBe(
      "Proposed staged content",
    );
  });
  it("rejects a staged change when the real file changes during approval", async () => {
    await acpFixture();
    const id = await send("STAGED");
    const pending = await approval(id);
    writeFileSync(join(directory, "workspace/staged.txt"), "A newer human edit");
    await app.inject({
      method: "POST",
      url: `/api/approvals/${pending.id}`,
      headers,
      payload: { approved: true },
    });
    await finish(id);
    expect(readFileSync(join(directory, "workspace/staged.txt"), "utf8")).toBe(
      "A newer human edit",
    );
  });
  it("cancels active work when an agent is disabled and leaves native chat selectable", async () => {
    await acpFixture();
    const id = await send();
    await approval(id);
    const response = await app.inject({
      method: "PATCH",
      url: "/api/runners/installations/acp%3Afixture-agent",
      headers,
      payload: { enabled: false },
    });
    expect(response.statusCode).toBe(200);
    await finish(id, "cancelled");
    expect(listApprovals(storage.db, id)[0]?.status).toBe("cancelled");
    const rejected = await app.inject({
      method: "POST",
      url: `/api/channels/${channelId}/messages`,
      headers,
      payload: { content: "Hello" },
    });
    expect(rejected.statusCode).toBe(409);
    const native = await app.inject({
      method: "POST",
      url: `/api/channels/${channelId}/messages`,
      headers,
      payload: { content: "Hello", runner: "native" },
    });
    expect(native.statusCode).toBe(201);
    expect(native.json().run.runner).toBe("native");
    await finish(native.json().run.id);
    expect(nativeRequests).toBe(1);
    expect(
      listMessages(storage.db, channelId).messages.some(
        (message) =>
          message.runId === native.json().run.id && message.content === "Native still works.",
      ),
    ).toBe(true);
  });
});

describe("native agent connection", () => {
  it("connects Codex in one request, encrypts its account and runs using native auth in isolation", async () => {
    vi.spyOn(native, "discoverNativeRunners").mockResolvedValue([
      { name: "codex", command: join(directory, "agent.py") },
    ]);
    vi.spyOn(native, "readNativeAccount").mockResolvedValue({
      runner: "codex",
      auth: {
        tokens: { access_token: "native-access-fixture", refresh_token: "native-refresh-fixture" },
      },
      hosts: ["api.openai.com", "chatgpt.com", "auth.openai.com"],
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/runners/connect",
      headers,
      payload: { runner: "codex" },
    });
    expect(response.statusCode, response.payload).toBe(200);
    expect(response.json()).toEqual({ connected: true });
    const installs = new RunnerInstallations(storage.db, directory, storage.secretsKey);
    expect(installs.get("codex")).toMatchObject({ enabled: true, authKind: "native-account" });
    expect(installs.get("codex")!.args).not.toContain('model_provider="vektor"');
    expect(installs.get("codex")!.args).toContain("features.shell_tool=false");
    const view = await app.inject({ method: "GET", url: "/api/runners", headers });
    expect(view.payload).not.toContain("native-access-fixture");
    expect(getSetting(storage.db, "runner.credentials.codex")).not.toContain(
      "native-access-fixture",
    );
    expect(installs.secrets()).toContain("native-refresh-fixture");
    const id = await send("NATIVE_AUTH");
    await finish(id);
    expect(installs.credential("codex")).toContain("native-refreshed-fixture");
    const snapshot = new HarnessSnapshots(directory, storage.secretsKey);
    const restored = await snapshot.home(id);
    expect(existsSync(join(restored, ".codex/auth.json"))).toBe(false);
    rmSync(restored, { recursive: true, force: true });
    expect(nativeRequests).toBe(0);
  });
  it("preserves an existing installation if native sign-in is missing", async () => {
    vi.spyOn(native, "discoverNativeRunners").mockResolvedValue([
      { name: "codex", command: join(directory, "agent.py") },
    ]);
    vi.spyOn(native, "readNativeAccount").mockRejectedValue(new Error("Sign in with codex login"));
    const before = getSetting(storage.db, "runner.installations");
    const response = await app.inject({
      method: "POST",
      url: "/api/runners/connect",
      headers,
      payload: { runner: "codex" },
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(getSetting(storage.db, "runner.installations")).toEqual(before);
  });
  it("honors emergency stop before native detection or account import", async () => {
    const discover = vi.spyOn(native, "discoverNativeRunners");
    await app.inject({ method: "POST", url: "/api/runtime/emergency-stop", headers });
    const response = await app.inject({
      method: "POST",
      url: "/api/runners/connect",
      headers,
      payload: { runner: "codex" },
    });
    expect(response.statusCode).toBe(423);
    expect(discover).not.toHaveBeenCalled();
  });
});

it("loads Codex's own catalog without workspace grants, chat messages or an inference turn", async () => {
  setSetting(storage.db, `runner.grant.${profileId}`, {
    runner: "codex",
    workspace: false,
    inference: false,
  });
  const response = await app.inject({ method: "GET", url: "/api/runners/codex/models", headers });
  expect(response.statusCode, response.payload).toBe(200);
  expect(response.json()).toMatchObject({
    defaultModel: "fixture-codex-default",
    models: [
      { id: "fixture-codex-default", name: "Codex default" },
      { id: "fixture-codex-other", name: "Codex other" },
    ],
  });
  expect(response.payload).not.toContain("external-dummy-secret");
  expect(listMessages(storage.db, channelId).messages).toHaveLength(0);
  expect(nativeRequests).toBe(0);
  expect(existsSync(join(directory, "workspace/hello.txt"))).toBe(false);
});
it("resolves Codex's default model when a queued message uses agent-default", async () => {
  const id = await send("ISOLATION", { model: "agent-default" });
  await finish(id);
  expect(getRun(storage.db, id)?.model).toBe("fixture-codex-default");
});
it("does not launch disabled runners when loading a model catalog", async () => {
  const entries = getSetting(storage.db, "runner.installations") as Array<Record<string, unknown>>;
  setSetting(
    storage.db,
    "runner.installations",
    entries.map((entry) => ({ ...entry, enabled: false })),
  );
  const response = await app.inject({ method: "GET", url: "/api/runners/codex/models", headers });
  expect(response.statusCode).toBe(409);
  expect(response.payload).toContain("Connect and enable");
});

it("returns actionable permission codes and accepts an explicitly approved conversation setup", async () => {
  await app.inject({
    method: "PATCH",
    url: `/api/profiles/${profileId}`,
    headers,
    payload: { terminalMode: "no-terminal", tools: [] },
  });
  setSetting(storage.db, `runner.grant.${profileId}`, {
    runner: "codex",
    workspace: false,
    inference: false,
  });
  const blocked = await app.inject({
    method: "POST",
    url: `/api/channels/${channelId}/messages`,
    headers,
    payload: { content: "ISOLATION" },
  });
  expect(blocked.statusCode).toBe(409);
  expect(blocked.json().error.code).toBe("runner_permissions");
  expect(blocked.json().error.message).toContain("Review permissions");
  expect(blocked.payload).not.toContain("mappings are unsupported");
  const saved = await app.inject({
    method: "PATCH",
    url: `/api/channels/${channelId}`,
    headers,
    payload: { execution: { terminalMode: "full-access", sshConnectionId: null } },
  });
  expect(saved.statusCode, saved.payload).toBe(200);
  const grantBlocked = await app.inject({
    method: "POST",
    url: `/api/channels/${channelId}/messages`,
    headers,
    payload: { content: "ISOLATION" },
  });
  expect(grantBlocked.json().error.code).toBe("runner_grants");
  const granted = await app.inject({
    method: "PUT",
    url: `/api/profiles/${profileId}/runner-grant`,
    headers,
    payload: { runner: "codex", workspace: true, inference: true },
  });
  expect(granted.statusCode).toBe(200);
  const runId = await send("ISOLATION");
  await finish(runId);
  const profiles = (await app.inject({ method: "GET", url: "/api/profiles", headers })).json()
    .profiles;
  expect(profiles.find((entry: { id: string }) => entry.id === profileId).terminalMode).toBe(
    "no-terminal",
  );
});

it("does not apply an OpenRouter fallback context limit to Codex", async () => {
  setSetting(storage.db, "provider.openrouter.models", {
    fetchedAt: Date.now(),
    models: [{ id: "test-model", name: "Unrelated native model", contextLength: 8192 }],
  });
  const preview = await app.inject({
    method: "POST",
    url: `/api/channels/${channelId}/context`,
    headers,
    payload: { content: "word ".repeat(9000) },
  });
  expect(preview.statusCode, preview.payload).toBe(200);
  expect(preview.json()).toMatchObject({
    contextWindow: null,
    availableInputTokens: null,
    windowSource: "unknown",
    exceedsBudget: false,
    droppedMessages: 0,
  });
  expect(preview.json().inputTokens).toBeGreaterThan(8192);
  expect(preview.json().warnings.join(" ")).not.toContain("8,192");
});
it("persists and streams Codex context separately from cumulative usage and learns its real window", async () => {
  const runId = await send("CONTEXT_REPORT");
  await finish(runId);
  const run = getRun(storage.db, runId)!;
  expect((run.harness as { context: unknown }).context).toEqual({
    inputTokens: 2000,
    outputTokens: 10,
    totalTokens: 2010,
    contextWindow: 272000,
  });
  expect(run.usage).toMatchObject({
    promptTokens: 10000,
    completionTokens: 50,
    totalTokens: 10050,
  });
  const events = listRunEvents(storage.db, runId).map((event) => JSON.parse(event.payloadJson));
  expect(
    events.some((event) => event.type === "context.updated" && event.context.totalTokens === 2010),
  ).toBe(true);
  const preview = await app.inject({
    method: "POST",
    url: `/api/channels/${channelId}/context`,
    headers,
    payload: { content: "Next message" },
  });
  expect(preview.json()).toMatchObject({ contextWindow: 272000, windowSource: "agent" });
});
