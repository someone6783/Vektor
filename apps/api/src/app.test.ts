import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  apiErrorSchema,
  healthResponseSchema,
  runEventSchema,
  type RunEvent,
} from "@vektor/shared";
import { buildApp } from "./app.js";
import { bootstrapStorage } from "./bootstrap.js";
import type { AppConfig } from "./config.js";

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
