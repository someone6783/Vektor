import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  apiErrorSchema,
  channelSchema,
  healthResponseSchema,
  messagesResponseSchema,
  profileSchema,
  runEventSchema,
  runSchema,
  sendMessageResponseSchema,
  settingsSchema,
  type RunEvent,
} from "@vektor/shared";
import { buildApp } from "./app.js";
import { bootstrapStorage } from "./bootstrap.js";
import type { AppConfig } from "./config.js";
import type { ChatProvider } from "./providers/index.js";

const ACCESS_TOKEN = "test-token-1234567890";

function testConfig(dataDir: string): AppConfig {
  return {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 0,
    dataDir,
    accessTokenOverride: ACCESS_TOKEN,
    enableDevStream: true,
    devStreamDelayMs: 0,
    logLevel: "silent",
    webDistDir: join(dataDir, "missing-web-dist"),
    version: "0.1.0",
    openRouterBaseUrl: "https://openrouter.ai/api/v1",
    openRouterModel: "openrouter/auto",
  };
}

function readEvents(payload: string): RunEvent[] {
  return payload
    .split("\n\n")
    .filter((frame) => frame.trim().length > 0)
    .map((frame) => {
      const data = frame
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice("data: ".length);

      if (!data) {
        throw new Error(`SSE frame has no data: ${frame}`);
      }

      return runEventSchema.parse(JSON.parse(data));
    });
}

let dataDir: string;
let app: FastifyInstance;

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "vektor-api-"));
  const config = testConfig(dataDir);
  app = await buildApp({
    config,
    storage: bootstrapStorage(config),
    logger: false,
  });
});

afterEach(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("GET /healthz", () => {
  it("reports a healthy database and a stable instance id", async () => {
    const response = await app.inject({ method: "GET", url: "/healthz" });

    expect(response.statusCode).toBe(200);
    const body = healthResponseSchema.parse(response.json());
    expect(body.status).toBe("ok");
    expect(body.database).toBe("ok");
    expect(body.instanceId).toBeTruthy();
    expect(body.version).toBe("0.1.0");
  });
});

describe("access token", () => {
  it("returns 401 for API routes without a token", async () => {
    const response = await app.inject({ method: "GET", url: "/api/dev/stream" });

    expect(response.statusCode).toBe(401);
    const body = apiErrorSchema.parse(response.json());
    expect(body.error.code).toBe("unauthorized");
  });

  it("returns 401 for a wrong token", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/dev/stream",
      headers: { authorization: "Bearer wrong-token-0000000" },
    });

    expect(response.statusCode).toBe(401);
  });

  it("accepts a valid token", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/dev/stream",
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
  });
});

describe("GET /api/dev/stream", () => {
  it("streams ordered events and completes", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/dev/stream",
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
    });

    expect(response.statusCode).toBe(200);
    const events = readEvents(response.payload);

    expect(events.map((event) => event.seq)).toEqual(
      Array.from({ length: 22 }, (_, index) => index + 1),
    );
    expect(events[0]?.type).toBe("run.started");
    expect(events.at(-1)?.type).toBe("run.completed");
    expect(events.filter((event) => event.type === "message.delta")).toHaveLength(20);
  });

  it("resumes after Last-Event-ID", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/dev/stream",
      headers: {
        authorization: `Bearer ${ACCESS_TOKEN}`,
        "last-event-id": "20",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(readEvents(response.payload).map((event) => event.seq)).toEqual([21, 22]);
  });

  it("resumes after the query cursor", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/dev/stream?after=21",
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
    });

    expect(readEvents(response.payload).map((event) => event.seq)).toEqual([22]);
  });
});

describe("error envelope", () => {
  it("returns a structured 404", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/does-not-exist",
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
    });

    expect(response.statusCode).toBe(404);
    const body = apiErrorSchema.parse(response.json());
    expect(body.error.code).toBe("not_found");
    expect(body.error.requestId).toBeTruthy();
  });
});

describe("GET /api/dev/provider", () => {
  it("streams normalized stub provider events", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/dev/provider",
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
    });

    expect(response.statusCode).toBe(200);

    const events = response.payload
      .split("\n\n")
      .filter((frame) => frame.trim().length > 0)
      .map((frame) => {
        const data = frame
          .split("\n")
          .find((line) => line.startsWith("data: "))
          ?.slice("data: ".length);
        return JSON.parse(data ?? "{}") as { type?: string; reason?: string };
      });

    expect(events.some((event) => event.type === "text.delta")).toBe(true);
    expect(events.some((event) => event.type === "tool_call")).toBe(true);
    expect(events.at(-1)).toEqual({ type: "finish", reason: "tool_calls" });
  });
});

const authHeaders = { authorization: `Bearer ${ACCESS_TOKEN}` };

async function createChannel(name = "Test channel") {
  const response = await app.inject({
    method: "POST",
    url: "/api/channels",
    headers: authHeaders,
    payload: { name },
  });
  expect(response.statusCode).toBe(201);
  return channelSchema.parse(response.json().channel);
}

async function sendMessage(channelId: string, content: string) {
  const response = await app.inject({
    method: "POST",
    url: `/api/channels/${channelId}/messages`,
    headers: authHeaders,
    payload: { content },
  });
  expect(response.statusCode).toBe(201);
  return sendMessageResponseSchema.parse(response.json());
}

async function readRunEvents(runId: string) {
  const response = await app.inject({
    method: "GET",
    url: `/api/runs/${runId}/events`,
    headers: authHeaders,
  });
  expect(response.statusCode).toBe(200);
  return readEvents(response.payload);
}

describe("settings", () => {
  it("defaults to stub mode with a fallback model", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/settings",
      headers: authHeaders,
    });

    expect(response.statusCode).toBe(200);
    const settings = settingsSchema.parse(response.json());
    expect(settings.openRouterConfigured).toBe(false);
    expect(settings.openRouterSource).toBe("none");
    expect(settings.defaultModel).toBe("openrouter/auto");
    expect(settings.models.some((model) => model.id === settings.defaultModel)).toBe(true);
  });

  it("stores a write-only key and updates the default model", async () => {
    const key = "sk-or-v1-test-key-1234567890";
    const response = await app.inject({
      method: "PUT",
      url: "/api/settings",
      headers: authHeaders,
      payload: { openRouterKey: key, defaultModel: "anthropic/claude-sonnet-4" },
    });

    expect(response.statusCode).toBe(200);
    const body = settingsSchema.parse(response.json());
    expect(body.openRouterConfigured).toBe(true);
    expect(body.openRouterSource).toBe("stored");
    expect(body.defaultModel).toBe("anthropic/claude-sonnet-4");
    expect(JSON.stringify(body)).not.toContain(key);

    const cleared = await app.inject({
      method: "PUT",
      url: "/api/settings",
      headers: authHeaders,
      payload: { openRouterKey: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(settingsSchema.parse(cleared.json()).openRouterSource).toBe("none");
  });

  it("rejects unknown settings fields", async () => {
    const response = await app.inject({
      method: "PUT",
      url: "/api/settings",
      headers: authHeaders,
      payload: { defaultModel: "openrouter/auto", surprise: true },
    });

    expect(response.statusCode).toBe(400);
    expect(apiErrorSchema.parse(response.json()).error.code).toBe("validation_error");
  });
});

describe("profiles", () => {
  it("bootstraps a default profile", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/profiles",
      headers: authHeaders,
    });

    expect(response.statusCode).toBe(200);
    const profiles = profileSchema.array().parse(response.json().profiles);
    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.name).toBe("Default");
    expect(profiles[0]?.model).toBe("openrouter/auto");
  });

  it("creates, updates, and archives a profile", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/profiles",
      headers: authHeaders,
      payload: { name: "Researcher", model: "openai/gpt-4.1", color: "sky" },
    });

    expect(created.statusCode).toBe(201);
    const profile = profileSchema.parse(created.json().profile);

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/profiles/${profile.id}`,
      headers: authHeaders,
      payload: { name: "Analyst", temperature: 0.2, maxTokens: 4096 },
    });

    expect(updated.statusCode).toBe(200);
    const patched = profileSchema.parse(updated.json().profile);
    expect(patched.name).toBe("Analyst");
    expect(patched.temperature).toBe(0.2);
    expect(patched.maxTokens).toBe(4096);

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/profiles/${profile.id}`,
      headers: authHeaders,
    });
    expect(removed.statusCode).toBe(204);

    const listed = await app.inject({
      method: "GET",
      url: "/api/profiles",
      headers: authHeaders,
    });
    expect(profileSchema.array().parse(listed.json().profiles)).toHaveLength(1);
  });

  it("refuses to archive the last active profile", async () => {
    const listed = await app.inject({
      method: "GET",
      url: "/api/profiles",
      headers: authHeaders,
    });
    const [profile] = profileSchema.array().parse(listed.json().profiles);

    const response = await app.inject({
      method: "DELETE",
      url: `/api/profiles/${profile!.id}`,
      headers: authHeaders,
    });

    expect(response.statusCode).toBe(409);
    expect(apiErrorSchema.parse(response.json()).error.code).toBe("last_profile");
  });
});

describe("channels", () => {
  it("creates, renames, and archives a channel", async () => {
    const empty = await app.inject({
      method: "GET",
      url: "/api/channels",
      headers: authHeaders,
    });
    expect(channelSchema.array().parse(empty.json().channels)).toEqual([]);

    const channel = await createChannel("Research");

    const renamed = await app.inject({
      method: "PATCH",
      url: `/api/channels/${channel.id}`,
      headers: authHeaders,
      payload: { name: "Deep research", topic: "Long-form work" },
    });
    expect(renamed.statusCode).toBe(200);
    const patched = channelSchema.parse(renamed.json().channel);
    expect(patched.name).toBe("Deep research");
    expect(patched.topic).toBe("Long-form work");

    const archived = await app.inject({
      method: "DELETE",
      url: `/api/channels/${channel.id}`,
      headers: authHeaders,
    });
    expect(archived.statusCode).toBe(204);

    const listed = await app.inject({
      method: "GET",
      url: "/api/channels",
      headers: authHeaders,
    });
    expect(channelSchema.array().parse(listed.json().channels)).toEqual([]);

    const withArchived = await app.inject({
      method: "GET",
      url: "/api/channels?includeArchived=1",
      headers: authHeaders,
    });
    expect(channelSchema.array().parse(withArchived.json().channels)).toHaveLength(1);
  });

  it("rejects an unknown profile", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/channels",
      headers: authHeaders,
      payload: { name: "Orphan", profileId: "missing-profile" },
    });

    expect(response.statusCode).toBe(400);
    expect(apiErrorSchema.parse(response.json()).error.code).toBe("invalid_profile");
  });
});

describe("messages and runs", () => {
  it("streams, persists, and replays a run", async () => {
    const channel = await createChannel();
    const sent = await sendMessage(channel.id, "Hello Vektor");

    expect(sent.message.role).toBe("user");
    expect(sent.run.status).toBe("running");

    const events = await readRunEvents(sent.run.id);
    expect(events[0]?.type).toBe("run.started");
    expect(events.at(-1)?.type).toBe("run.completed");
    expect(events.filter((event) => event.type === "message.delta").length).toBeGreaterThan(0);
    expect(events.map((event) => event.seq)).toEqual(
      Array.from({ length: events.length }, (_, index) => index + 1),
    );

    const history = await app.inject({
      method: "GET",
      url: `/api/channels/${channel.id}/messages`,
      headers: authHeaders,
    });
    expect(history.statusCode).toBe(200);
    const page = messagesResponseSchema.parse(history.json());
    expect(page.messages).toHaveLength(2);
    expect(page.messages[0]?.role).toBe("user");
    expect(page.messages[1]?.role).toBe("assistant");
    expect(page.messages[1]?.status).toBe("complete");
    expect(page.activeRun).toBeNull();

    const replayed = await readRunEvents(sent.run.id);
    expect(replayed).toEqual(events);

    const resumed = await app.inject({
      method: "GET",
      url: `/api/runs/${sent.run.id}/events`,
      headers: { ...authHeaders, "last-event-id": "2" },
    });
    expect(resumed.statusCode).toBe(200);
    const tail = readEvents(resumed.payload);
    expect(tail.length).toBeGreaterThan(0);
    expect(tail.every((event) => event.seq > 2)).toBe(true);
  });

  it("paginates history with a before cursor", async () => {
    const channel = await createChannel();

    const first = await sendMessage(channel.id, "First question");
    await readRunEvents(first.run.id);
    const second = await sendMessage(channel.id, "Second question");
    await readRunEvents(second.run.id);

    const latest = await app.inject({
      method: "GET",
      url: `/api/channels/${channel.id}/messages?limit=1`,
      headers: authHeaders,
    });
    const latestPage = messagesResponseSchema.parse(latest.json());
    expect(latestPage.messages).toHaveLength(1);
    expect(latestPage.nextBefore).not.toBeNull();

    const older = await app.inject({
      method: "GET",
      url: `/api/channels/${channel.id}/messages?limit=1&before=${latestPage.nextBefore}`,
      headers: authHeaders,
    });
    const olderPage = messagesResponseSchema.parse(older.json());
    expect(olderPage.messages).toHaveLength(1);
    expect(olderPage.messages[0]?.id).not.toBe(latestPage.messages[0]?.id);
  });

  it("retries a completed run and replaces the assistant message", async () => {
    const channel = await createChannel();
    const sent = await sendMessage(channel.id, "Say something");
    const originalEvents = await readRunEvents(sent.run.id);
    expect(originalEvents.at(-1)?.type).toBe("run.completed");

    const retried = await app.inject({
      method: "POST",
      url: `/api/runs/${sent.run.id}/retry`,
      headers: authHeaders,
    });
    expect(retried.statusCode).toBe(201);
    const run = runSchema.parse(retried.json().run);
    expect(run.userMessageId).toBe(sent.message.id);

    const events = await readRunEvents(run.id);
    expect(events.at(-1)?.type).toBe("run.completed");

    const history = await app.inject({
      method: "GET",
      url: `/api/channels/${channel.id}/messages`,
      headers: authHeaders,
    });
    const page = messagesResponseSchema.parse(history.json());
    expect(page.messages.filter((message) => message.role === "user")).toHaveLength(1);
    const assistants = page.messages.filter((message) => message.role === "assistant");
    expect(assistants).toHaveLength(1);
    expect(assistants[0]?.runId).toBe(run.id);
  });

  it("cancels an active run and persists a cancelled message", async () => {
    const cancelDir = mkdtempSync(join(tmpdir(), "vektor-api-cancel-"));
    const config = testConfig(cancelDir);
    const slowProvider: ChatProvider = {
      async *streamChat(request) {
        for (let index = 0; index < 200; index += 1) {
          if (request.signal?.aborted) {
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
          yield { type: "text.delta", text: "x" };
        }
        yield { type: "finish", reason: "stop" };
      },
    };

    const slowApp = await buildApp({
      config,
      storage: bootstrapStorage(config),
      logger: false,
      provider: slowProvider,
    });

    try {
      const profilesResponse = await slowApp.inject({
        method: "GET",
        url: "/api/profiles",
        headers: authHeaders,
      });
      const [profile] = profileSchema.array().parse(profilesResponse.json().profiles);
      const channelResponse = await slowApp.inject({
        method: "POST",
        url: "/api/channels",
        headers: authHeaders,
        payload: { name: "Slow", profileId: profile!.id },
      });
      const channel = channelSchema.parse(channelResponse.json().channel);

      const sentResponse = await slowApp.inject({
        method: "POST",
        url: `/api/channels/${channel.id}/messages`,
        headers: authHeaders,
        payload: { content: "Take your time" },
      });
      const sent = sendMessageResponseSchema.parse(sentResponse.json());

      const cancel = await slowApp.inject({
        method: "POST",
        url: `/api/runs/${sent.run.id}/cancel`,
        headers: authHeaders,
      });
      expect(cancel.statusCode).toBe(202);
      expect(cancel.json()).toEqual({ cancelled: true });

      const eventsResponse = await slowApp.inject({
        method: "GET",
        url: `/api/runs/${sent.run.id}/events`,
        headers: authHeaders,
      });
      const events = readEvents(eventsResponse.payload);
      expect(events.at(-1)?.type).toBe("run.cancelled");

      const history = await slowApp.inject({
        method: "GET",
        url: `/api/channels/${channel.id}/messages`,
        headers: authHeaders,
      });
      const page = messagesResponseSchema.parse(history.json());
      const assistant = page.messages.find((message) => message.role === "assistant");
      expect(assistant?.status).toBe("cancelled");
      expect(assistant?.runId).toBe(sent.run.id);
    } finally {
      await slowApp.close();
      rmSync(cancelDir, { recursive: true, force: true });
    }
  });
});
