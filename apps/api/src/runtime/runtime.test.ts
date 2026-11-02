import { mkdtempSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getRun,
  updateProfile,
  getChannel,
  getProfile,
  updateChannel,
  listApprovals,
  listAudit,
  listMessages,
  listToolCalls,
  createRun,
  createMessage,
  createToolCall,
  createApproval,
  listRunEvents,
} from "@vektor/db";
import { buildApp } from "../app.js";
import { bootstrapStorage, type Storage } from "../bootstrap.js";
import { loadConfig, type AppConfig } from "../config.js";
import type { ChatProvider, ChatRequest } from "../providers/types.js";

let app: FastifyInstance;
let storage: Storage;
let config: AppConfig;
let directory: string;
let profileId: string;
let channelId: string;
let requests: ChatRequest[];
let commands: Array<{ command: string; args: string[]; cwd?: string; timeoutMs?: number }>;
let provider: ChatProvider;
const headers = { authorization: "Bearer runtime-test-access-token" };
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "vektor-runtime-"));
  config = loadConfig({
    NODE_ENV: "test",
    VEKTOR_DATA_DIR: directory,
    VEKTOR_ACCESS_TOKEN: "runtime-test-access-token",
    VEKTOR_WEB_DIST: join(directory, "no-web"),
  });
  requests = [];
  commands = [{ command: "pwd", args: [] }];
  provider = {
    async *streamChat(request) {
      requests.push({ ...request, messages: structuredClone(request.messages) });
      if (request.messages.at(-1)?.role !== "tool") {
        for (const [index, command] of commands.entries())
          yield {
            type: "tool_call",
            id: `call-${index}`,
            name: "terminal",
            argumentsJson: JSON.stringify(command),
          };
        yield { type: "usage", promptTokens: 10, completionTokens: 2, totalTokens: 12 };
        yield { type: "finish", reason: "tool_calls" };
      } else {
        yield { type: "text.delta", text: "Command reviewed." };
        yield { type: "usage", promptTokens: 20, completionTokens: 3, totalTokens: 23 };
        yield { type: "finish", reason: "stop" };
      }
    },
  };
  await open();
  profileId = (await app.inject({ method: "GET", url: "/api/profiles", headers })).json()
    .profiles[0].id;
  channelId = (
    await app.inject({
      method: "POST",
      url: "/api/channels",
      headers,
      payload: { name: "Runtime", profileId },
    })
  ).json().channel.id;
});
afterEach(async () => {
  await app.close();
  rmSync(directory, { recursive: true, force: true });
});
async function open() {
  storage = bootstrapStorage(config);
  app = await buildApp({ config, storage, provider, logger: false });
}
async function mode(terminalMode: string, tools = ["terminal"]) {
  return app.inject({
    method: "PATCH",
    url: `/api/profiles/${profileId}`,
    headers,
    payload: { terminalMode, tools },
  });
}
async function send() {
  return app.inject({
    method: "POST",
    url: `/api/channels/${channelId}/messages`,
    headers,
    payload: { content: "Run the requested command" },
  });
}
async function completed(id: string) {
  await vi.waitFor(() => expect(getRun(storage.db, id)?.status).not.toBe("running"), {
    timeout: 3000,
  });
}

describe("permissioned runtime API", () => {
  it("applies saved conversation permissions without changing the shared profile", async () => {
    const patch = await app.inject({
      method: "PATCH",
      url: `/api/channels/${channelId}`,
      headers,
      payload: {
        execution: {
          terminalMode: "basic",
          browser: { mode: "observe", allowedOrigins: ["https://example.com"] },
        },
      },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().channel.execution.terminalMode).toBe("basic");
    expect(getProfile(storage.db, profileId)?.terminalMode).toBe("no-terminal");
    const channels = (await app.inject({ method: "GET", url: "/api/channels", headers })).json()
      .channels;
    expect(
      channels.find((channel: { id: string }) => channel.id === channelId).execution.browser.mode,
    ).toBe("observe");
    const { run } = (await send()).json();
    await completed(run.id);
    expect(getRun(storage.db, run.id)?.status).toBe("completed");
    expect(getRun(storage.db, run.id)?.terminalMode).toBe("basic");
    expect(requests[0]?.tools?.map((tool) => tool.function.name)).toEqual(["terminal", "browser"]);
    const other = (
      await app.inject({
        method: "POST",
        url: "/api/channels",
        headers,
        payload: { name: "Other", profileId },
      })
    ).json().channel;
    expect(other.execution).toEqual({});
    const reset = await app.inject({
      method: "PATCH",
      url: `/api/channels/${channelId}`,
      headers,
      payload: { execution: null },
    });
    expect(reset.json().channel.execution).toEqual({});
  });
  it("cancels active work when conversation permissions change", async () => {
    await app.inject({
      method: "PATCH",
      url: `/api/channels/${channelId}`,
      headers,
      payload: { execution: { terminalMode: "full-access" } },
    });
    const { run } = (await send()).json();
    await vi.waitFor(() => expect(listApprovals(storage.db, run.id)).toHaveLength(1));
    await app.inject({
      method: "PATCH",
      url: `/api/channels/${channelId}`,
      headers,
      payload: { execution: { terminalMode: "no-terminal" } },
    });
    expect(getRun(storage.db, run.id)?.status).toBe("cancelled");
  });

  it.each(["success", "failure", "manual rename"])(
    "names a temporary DM after its reply: %s",
    async (scenario) => {
      await app.close();
      provider = {
        async *streamChat(request) {
          requests.push(request);
          if (request.maxTokens === 64) {
            if (scenario === "manual rename")
              updateChannel(storage.db, channelId, { name: "My chosen name" });
            if (scenario === "failure") throw new Error("Title generation unavailable");
            yield { type: "text.delta", text: '"Working with files"' };
          } else yield { type: "text.delta", text: "Here is the reply." };
          yield { type: "usage", promptTokens: 10, completionTokens: 5, totalTokens: 15 };
          yield { type: "finish", reason: "stop" };
        },
      };
      await open();
      channelId = (
        await app.inject({
          method: "POST",
          url: "/api/channels",
          headers,
          payload: { name: "New conversation 1", kind: "dm", profileId },
        })
      ).json().channel.id;
      const { run } = (await send()).json();
      await completed(run.id);
      expect(getRun(storage.db, run.id)?.status).toBe("completed");
      expect(getChannel(storage.db, channelId)?.name).toBe(
        scenario === "success"
          ? "Working with files"
          : scenario === "manual rename"
            ? "My chosen name"
            : "New conversation 1",
      );
      expect(
        listMessages(storage.db, channelId).messages.filter(
          (message) => message.role === "assistant",
        ),
      ).toEqual([expect.objectContaining({ content: "Here is the reply." })]);
      expect(requests).toHaveLength(2);
      expect(getRun(storage.db, run.id)?.providerCalls).toBe(2);
      if (scenario !== "failure") expect(getRun(storage.db, run.id)?.usage?.totalTokens).toBe(30);
    },
  );

  it("rolls back a failed completion as one unit before persisting a failed run", async () => {
    await mode("basic");
    storage.sqlite.exec(
      "CREATE TRIGGER fail_completion BEFORE INSERT ON run_events WHEN NEW.type = 'run.completed' BEGIN SELECT RAISE(ABORT, 'Completion storage unavailable'); END;",
    );
    const { run } = (await send()).json();
    await completed(run.id);
    expect(getRun(storage.db, run.id)?.status).toBe("failed");
    const assistant = listMessages(storage.db, channelId).messages.filter(
      (message) => message.role === "assistant",
    );
    expect(assistant).toHaveLength(1);
    expect(assistant[0]?.status).toBe("failed");
    const events = listRunEvents(storage.db, run.id);
    expect(events.filter((event) => event.type === "run.completed")).toHaveLength(0);
    expect(events.filter((event) => event.type === "run.failed")).toHaveLength(1);
  });
  it("keeps output and persisted events free of known secrets, including split text chunks", async () => {
    await app.close();
    provider = {
      async *streamChat() {
        yield { type: "text.delta", text: "x".repeat(180) + "runtime-test-" };
        yield { type: "text.delta", text: "access-token" + "y".repeat(180) };
        yield { type: "finish", reason: "stop" };
      },
    };
    await open();
    const { run } = (await send()).json();
    await completed(run.id);
    const events = listRunEvents(storage.db, run.id).map((event) => JSON.parse(event.payloadJson));
    const text = events
      .filter((event) => event.type === "message.delta")
      .map((event) => event.text)
      .join("");
    expect(text).toContain("[redacted]");
    expect(text).not.toContain("runtime-test-access-token");
    expect(
      listMessages(storage.db, channelId).messages.find((message) => message.role === "assistant")
        ?.content,
    ).toBe(text);
  });

  it("redacts a credential read by an explicitly approved tool before persisting or returning it", async () => {
    await mode("full-access");
    writeFileSync(join(directory, "credential.txt"), "runtime-test-access-token");
    commands = [{ command: "cat", args: [join(directory, "credential.txt")] }];
    const { run } = (await send()).json();
    const approval = listApprovals(storage.db, run.id)[0]!;
    await app.inject({
      method: "POST",
      url: `/api/approvals/${approval.id}`,
      headers,
      payload: { approved: true },
    });
    await completed(run.id);
    expect(listToolCalls(storage.db, run.id)[0]?.output).toContain("[redacted]");
    expect(JSON.stringify(listRunEvents(storage.db, run.id))).not.toContain(
      "runtime-test-access-token",
    );
    expect(JSON.stringify(listAudit(storage.db))).not.toContain("runtime-test-access-token");
  });

  it("cancels immediately even when a provider ignores its abort signal, retaining partial output", async () => {
    await app.close();
    let finish = () => {};
    const waiting = new Promise<void>((resolve) => {
      finish = resolve;
    });
    provider = {
      async *streamChat() {
        yield { type: "text.delta", text: "partial reply" };
        await waiting;
        yield { type: "finish", reason: "stop" };
      },
    };
    await open();
    const { run } = (await send()).json();
    expect(
      (await app.inject({ method: "POST", url: `/api/runs/${run.id}/cancel`, headers })).statusCode,
    ).toBe(202);
    expect(getRun(storage.db, run.id)?.status).toBe("cancelled");
    expect(
      listMessages(storage.db, channelId).messages.find((message) => message.role === "assistant")
        ?.content,
    ).toBe("partial reply");
    finish();
  });

  it("bounds repeated tool requests and fails rather than looping forever", async () => {
    await app.close();
    provider = {
      async *streamChat() {
        yield {
          type: "tool_call",
          id: "repeated",
          name: "terminal",
          argumentsJson: JSON.stringify({ command: "pwd" }),
        };
        yield { type: "finish", reason: "tool_calls" };
      },
    };
    await open();
    await mode("basic");
    const { run } = (await send()).json();
    await completed(run.id);
    expect(getRun(storage.db, run.id)).toMatchObject({
      status: "failed",
      error: expect.stringContaining("eight-step"),
    });
    expect(listToolCalls(storage.db, run.id)).toHaveLength(8);
  });
  it("never exposes or executes terminal in no-terminal mode, even for unsolicited calls", async () => {
    await mode("no-terminal", ["terminal"]);
    const response = await send();
    expect(response.statusCode).toBe(201);
    const run = response.json().run;
    await completed(run.id);
    expect(requests[0]?.tools).toEqual([]);
    expect(listToolCalls(storage.db, run.id)[0]).toMatchObject({ status: "denied" });
    expect(listAudit(storage.db).some((row) => row.action === "tool.denied")).toBe(true);
  });

  it("redacts and persists reasoning separately from the answer", async () => {
    provider.streamChat = async function* () {
      yield { type: "reasoning.delta", text: "Consider runtime-test-" };
      yield { type: "reasoning.delta", text: "access-token before answering." };
      yield { type: "text.delta", text: "The answer." };
      yield { type: "finish", reason: "stop" };
    };
    const { run } = (await send()).json();
    await completed(run.id);
    const events = listRunEvents(storage.db, run.id).map((event) => JSON.parse(event.payloadJson));
    const reasoning = events
      .filter((event) => event.type === "reasoning.delta")
      .map((event) => event.text)
      .join("");
    expect(reasoning).toContain("Consider");
    expect(reasoning).not.toContain("runtime-test-access-token");
    const saved = listMessages(storage.db, channelId).messages.find(
      (message) => message.runId === run.id,
    );
    expect(saved?.content).toBe("The answer.");
    const result = await app.inject({ url: `/api/runs/${run.id}/details?transcript=1`, headers });
    expect(result.json().transcript.map((event: { type: string }) => event.type)).toEqual([
      "reasoning.delta",
      "message.delta",
    ]);
  });

  it("keeps reasoning settings through tool calls and retries while retaining opaque provider metadata only internally", async () => {
    await mode("basic");
    const original = provider.streamChat.bind(provider);
    const details = [{ type: "reasoning.encrypted", data: "opaque-provider-data", index: 0 }];
    provider.streamChat = async function* (request) {
      if (request.messages.at(-1)?.role !== "tool") {
        yield { type: "reasoning.delta", text: "Check the workspace." };
        yield { type: "reasoning.details", details };
      }
      yield* original(request);
    };
    const response = await app.inject({
      method: "POST",
      url: `/api/channels/${channelId}/messages`,
      headers,
      payload: { content: "Check", reasoning: "high" },
    });
    expect(response.statusCode).toBe(201);
    const run = response.json().run;
    await completed(run.id);
    expect(getRun(storage.db, run.id)?.context).toMatchObject({ reasoning: "high" });
    expect(requests.map((request) => request.reasoning)).toEqual(["high", "high"]);
    expect(requests[1]?.messages.at(-2)?.reasoning_details).toEqual(details);
    expect(JSON.stringify(listRunEvents(storage.db, run.id))).not.toContain("opaque-provider-data");
    const retry = await app.inject({
      method: "POST",
      url: `/api/runs/${run.id}/retry`,
      headers,
      payload: {},
    });
    expect(retry.statusCode).toBe(201);
    await completed(retry.json().run.id);
    expect(requests.every((request) => request.reasoning === "high")).toBe(true);
  });

  it("executes basic commands and sends tool results with matching call IDs back to the model", async () => {
    await mode("basic");
    const { run } = (await send()).json();
    await completed(run.id);
    const tools = listToolCalls(storage.db, run.id);
    expect(tools[0]?.status).toBe("completed");
    expect(tools[0]?.output).toContain(join(directory, "workspace"));
    expect(requests[0]?.tools?.[0]?.function.name).toBe("terminal");
    expect(requests[1]?.messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "call-0" });
    expect(requests[1]?.messages.at(-2)?.tool_calls?.[0]?.id).toBe("call-0");
    expect(getRun(storage.db, run.id)?.usage).toMatchObject({
      promptTokens: 30,
      completionTokens: 5,
      totalTokens: 35,
    });
    const details = await app.inject({
      method: "GET",
      url: `/api/runs/${run.id}/details`,
      headers,
    });
    expect(details.json().tools[0].status).toBe("completed");
    const transcript = await app.inject({
      method: "GET",
      url: `/api/runs/${run.id}/details?transcript=1`,
      headers,
    });
    const fullEvents = listRunEvents(storage.db, run.id).map((event) =>
      JSON.parse(event.payloadJson),
    );
    expect(
      transcript
        .json()
        .transcript.filter((event: { type: string }) => event.type === "tool.requested")
        .map((event: { toolCallId: string }) => event.toolCallId),
    ).toEqual(
      fullEvents
        .filter((event) => event.type === "tool.requested")
        .map((event) => event.toolCallId),
    );
    expect(
      transcript
        .json()
        .transcript.filter((event: { type: string }) => event.type === "message.delta")
        .map((event: { text: string }) => event.text)
        .join(""),
    ).toBe(
      fullEvents
        .filter((event) => event.type === "message.delta")
        .map((event) => event.text)
        .join(""),
    );

    expect(details.json().events.map((event: { type: string }) => event.type)).toContain(
      "tool.output",
    );
    expect((await app.inject({ method: "GET", url: "/api/audit" })).statusCode).toBe(401);
  });

  it("enforces the per-profile tool switch and the run deadline", async () => {
    await mode("basic", []);
    const disabled = (await send()).json().run;
    await completed(disabled.id);
    expect(listToolCalls(storage.db, disabled.id)[0]?.status).toBe("denied");
    await app.close();
    let finish = () => {};
    const waiting = new Promise<void>((resolve) => {
      finish = resolve;
    });
    provider = {
      async *streamChat() {
        await waiting;
        yield { type: "finish", reason: "stop" };
      },
    };
    config.runTimeoutMs = 1000;
    await open();
    const { run } = (await send()).json();
    await completed(run.id);
    expect(getRun(storage.db, run.id)).toMatchObject({
      status: "failed",
      error: expect.stringContaining("deadline"),
    });
    finish();
  });

  it.each(["profile", "conversation"])(
    "runs Full Unrestricted shell commands outside the workspace without approvals via %s settings",
    async (source) => {
      const response =
        source === "profile"
          ? await mode("full-unrestricted")
          : await app.inject({
              method: "PATCH",
              url: `/api/channels/${channelId}`,
              headers,
              payload: { execution: { terminalMode: "full-unrestricted" } },
            });
      expect(response.statusCode).toBe(200);
      const target = join(directory, "unrestricted-marker.txt");
      writeFileSync(target, "Remove without approval");
      commands = [{ command: "sh", args: ["-c", "rm unrestricted-marker.txt"], cwd: directory }];
      const { run } = (await send()).json();
      await completed(run.id);
      expect(getRun(storage.db, run.id)).toMatchObject({
        status: "completed",
        terminalMode: "full-unrestricted",
      });
      expect(existsSync(target)).toBe(false);
      expect(listToolCalls(storage.db, run.id)[0]?.status).toBe("completed");
      expect(listApprovals(storage.db, run.id)).toHaveLength(0);
      expect(
        listRunEvents(storage.db, run.id).some((event) => event.type === "approval.requested"),
      ).toBe(false);
      expect(
        requests[0]?.tools?.find((tool) => tool.function.name === "terminal")?.function.description,
      ).toContain("without user approval");
      expect(requests[0]?.messages[0]?.content).toContain("without user approval");
      if (source === "conversation")
        expect(getProfile(storage.db, profileId)?.terminalMode).toBe("no-terminal");
    },
  );

  it("requires approval before a full-access destructive command and accepts each approval once", async () => {
    await mode("full-access");
    const target = join(directory, "approval-marker.txt");
    writeFileSync(target, "Only remove after approval");
    commands = [{ command: "rm", args: [target] }];
    const { run } = (await send()).json();
    const approval = listApprovals(storage.db, run.id)[0]!;
    expect(approval?.status).toBe("pending");
    expect(existsSync(target)).toBe(true);
    expect(getRun(storage.db, run.id)?.status).toBe("running");
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/approvals/${approval.id}`,
          headers,
          payload: { approved: true },
        })
      ).statusCode,
    ).toBe(200);
    await completed(run.id);
    expect(existsSync(target)).toBe(false);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/approvals/${approval.id}`,
          headers,
          payload: { approved: true },
        })
      ).statusCode,
    ).toBe(409);
    expect(listToolCalls(storage.db, run.id)[0]?.status).toBe("completed");
  });

  it("denies commands without running them and rechecks permissions after approval", async () => {
    await mode("full-access");
    const target = join(directory, "denial-marker.txt");
    writeFileSync(target, "preserve");
    commands = [{ command: "rm", args: [target] }];
    const { run } = (await send()).json();
    const approval = listApprovals(storage.db, run.id)[0]!;
    await mode("no-terminal");
    await app.inject({
      method: "POST",
      url: `/api/approvals/${approval.id}`,
      headers,
      payload: { approved: true },
    });
    await completed(run.id);
    expect(existsSync(target)).toBe(true);
    expect(listToolCalls(storage.db, run.id)[0]?.status).toBe("denied");
    await mode("full-access");
    const second = (await send()).json().run;
    const denied = listApprovals(storage.db, second.id)[0]!;
    await app.inject({
      method: "POST",
      url: `/api/approvals/${denied.id}`,
      headers,
      payload: { approved: false },
    });
    await completed(second.id);
    expect(existsSync(target)).toBe(true);
    expect(listApprovals(storage.db, second.id)[0]?.status).toBe("denied");
  });

  it("cancels pending approvals and persists emergency-stop state across restart", async () => {
    await mode("full-access");
    const { run } = (await send()).json();
    const approval = listApprovals(storage.db, run.id)[0]!;
    expect(
      (await app.inject({ method: "POST", url: "/api/runtime/emergency-stop", headers }))
        .statusCode,
    ).toBe(200);
    expect(getRun(storage.db, run.id)?.status).toBe("cancelled");
    expect(listApprovals(storage.db, run.id)[0]?.status).toBe("cancelled");
    expect((await send()).statusCode).toBe(423);
    await app.close();
    await open();
    expect(
      (await app.inject({ method: "GET", url: "/api/runtime", headers })).json().emergencyStopped,
    ).toBe(true);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/approvals/${approval.id}`,
          headers,
          payload: { approved: true },
        })
      ).statusCode,
    ).toBe(409);
    await app.inject({ method: "POST", url: "/api/runtime/resume", headers });
    await mode("basic");
    const next = await send();
    expect(next.statusCode).toBe(201);
    await completed(next.json().run.id);
    expect(
      listMessages(storage.db, channelId).messages.some(
        (message) => message.status === "cancelled",
      ),
    ).toBe(true);
  });

  it("kills an active command on emergency stop and records cancellation", async () => {
    await mode("full-access");
    commands = [{ command: "sh", args: ["-c", "sleep 30 & wait"] }];
    const { run } = (await send()).json();
    const approval = listApprovals(storage.db, run.id)[0]!;
    await app.inject({
      method: "POST",
      url: `/api/approvals/${approval.id}`,
      headers,
      payload: { approved: true },
    });
    await vi.waitFor(() => expect(listToolCalls(storage.db, run.id)[0]?.status).toBe("running"));
    const started = Date.now();
    await app.inject({ method: "POST", url: "/api/runtime/emergency-stop", headers });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(getRun(storage.db, run.id)?.status).toBe("cancelled");
    expect(listToolCalls(storage.db, run.id)[0]?.status).toBe("cancelled");
  });

  it("recovers interrupted tool calls and approvals without replaying commands", async () => {
    const message = createMessage(storage.db, { channelId, role: "user", content: "Interrupted" });
    const run = createRun(storage.db, {
      channelId,
      profileId,
      userMessageId: message.id,
      model: "test",
    });
    const tool = createToolCall(storage.db, {
      runId: run.id,
      providerCallId: "old",
      name: "terminal",
      input: {},
    });
    createApproval(storage.db, run.id, tool.id, "Never replay this command");
    await app.close();
    await open();
    expect(getRun(storage.db, run.id)?.status).toBe("failed");
    expect(listToolCalls(storage.db, run.id)[0]?.status).toBe("cancelled");
    expect(listApprovals(storage.db, run.id)[0]?.status).toBe("cancelled");
    expect(requests).toHaveLength(0);
  });
});

describe("runner admission", () => {
  it("rejects unavailable runners before persisting user messages or contacting OpenRouter", async () => {
    for (const runner of ["codex", "cli", "acp:test-agent"]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/channels/${channelId}/messages`,
        headers,
        payload: { content: "Hello", runner },
      });
      expect(response.statusCode).toBe(409);
    }
    expect(listMessages(storage.db, channelId).messages).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });

  it("persists profile selection across restart and permits an explicit native override", async () => {
    updateProfile(storage.db, profileId, { runner: "codex" });
    await app.close();
    await open();
    expect(getProfile(storage.db, profileId)?.runner).toBe("codex");
    expect((await send()).statusCode).toBe(409);
    const response = await app.inject({
      method: "POST",
      url: `/api/channels/${channelId}/messages`,
      headers,
      payload: { content: "Hello", runner: "native" },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().run.runner).toBe("native");
    await vi.waitFor(() =>
      expect(getRun(storage.db, response.json().run.id)?.status).toBe("completed"),
    );
    expect(requests.length).toBeGreaterThan(0);
    expect(getProfile(storage.db, profileId)?.runner).toBe("codex");
  });

  it("retries the stored runner even after the profile runner changes", async () => {
    const response = await send();
    const id = response.json().run.id as string;
    await vi.waitFor(() => expect(getRun(storage.db, id)?.status).toBe("completed"));
    updateProfile(storage.db, profileId, { runner: "codex" });
    const retry = await app.inject({
      method: "POST",
      url: `/api/runs/${id}/retry`,
      headers,
      payload: {},
    });
    expect(retry.statusCode).toBe(201);
    expect(retry.json().run.runner).toBe("native");
    await vi.waitFor(() =>
      expect(getRun(storage.db, retry.json().run.id)?.status).toBe("completed"),
    );
  });

  it("does not retry an unavailable stored runner using a native profile", async () => {
    const message = createMessage(storage.db, { channelId, role: "user", content: "Hello" });
    const run = createRun(storage.db, {
      channelId,
      profileId,
      userMessageId: message.id,
      model: "test",
      runner: "codex",
    });
    const retry = await app.inject({
      method: "POST",
      url: `/api/runs/${run.id}/retry`,
      headers,
      payload: {},
    });
    expect(retry.statusCode).toBe(409);
    expect(requests).toHaveLength(0);
  });

  it("fails an existing scheduled job if its profile switches to an unavailable runner", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/jobs",
      headers,
      payload: {
        name: "Existing job",
        profileId,
        channelId,
        prompt: "Hello",
        schedule: "0 * * * *",
        timezone: "UTC",
      },
    });
    expect(created.statusCode).toBe(201);
    updateProfile(storage.db, profileId, { runner: "codex" });
    const response = await app.inject({
      method: "POST",
      url: `/api/jobs/${created.json().job.id}/run`,
      headers,
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().execution.status).toBe("failed");
    expect(response.json().execution.runId).toBeNull();
    expect(response.json().execution.error).toContain("runner is unavailable");
    expect(requests).toHaveLength(0);
  });

  it("rejects scheduled jobs targeting unavailable runners", async () => {
    updateProfile(storage.db, profileId, { runner: "codex" });
    const response = await app.inject({
      method: "POST",
      url: "/api/jobs",
      headers,
      payload: {
        name: "Codex job",
        profileId,
        channelId,
        prompt: "Hello",
        schedule: "0 * * * *",
        timezone: "UTC",
      },
    });
    expect(response.statusCode).toBe(409);
    expect(requests).toHaveLength(0);
  });
});
