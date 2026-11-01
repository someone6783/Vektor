import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { updateRun } from "@vektor/db";
import { bootstrapStorage, type Storage } from "../bootstrap.js";
import { loadConfig } from "../config.js";
import { buildApp, type VektorApp } from "../app.js";
import type { ChatProvider } from "../providers/types.js";

let app: VektorApp;
let storage: Storage;
let directory: string;
let profileId: string;
let channelId: string;
const headers = { authorization: "Bearer usage-test-access-token" };
const provider: ChatProvider = {
  kind: "openrouter",
  async *streamChat(request) {
    const content = JSON.stringify(
      request.messages.filter((message) => message.role === "user").at(-1),
    );
    yield { type: "text.delta", text: "Reported output" };
    if (content.includes("partial-price")) {
      yield { type: "usage", promptTokens: 4, completionTokens: 1, totalTokens: 5, costUsd: 0.003 };
      yield { type: "usage", promptTokens: 4, completionTokens: 2, totalTokens: 6 };
      yield { type: "finish", reason: "stop" };
      return;
    }
    if (content.includes("missing")) {
      yield { type: "finish", reason: "stop" };
      return;
    }
    if (content.includes("free")) {
      yield { type: "usage", promptTokens: 2, completionTokens: 1, totalTokens: 3, costUsd: 0 };
      yield { type: "finish", reason: "stop" };
      return;
    }
    if (content.includes("failure")) {
      yield { type: "usage", promptTokens: 4, completionTokens: 1, totalTokens: 5, costUsd: 0.005 };
      yield { type: "error", message: "Provider failed after reporting usage" };
      return;
    }
    if (request.messages.some((message) => message.role === "tool")) {
      yield { type: "usage", promptTokens: 3, completionTokens: 2, totalTokens: 5 };
      yield { type: "finish", reason: "stop" };
      return;
    }
    yield { type: "usage", promptTokens: 10, completionTokens: 4, totalTokens: 14, costUsd: 0.001 };
    yield { type: "usage", promptTokens: 10, completionTokens: 5, totalTokens: 15, costUsd: 0.002 };
    yield {
      type: "tool_call",
      id: "usage-pwd",
      name: "terminal",
      argumentsJson: '{"command":"pwd"}',
    };
    yield { type: "finish", reason: "tool_calls" };
  },
};
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "vektor-usage-"));
  const config = loadConfig({
    NODE_ENV: "test",
    VEKTOR_DATA_DIR: directory,
    VEKTOR_WEB_DIST: join(directory, "no-web"),
    VEKTOR_ACCESS_TOKEN: "usage-test-access-token",
  });
  storage = bootstrapStorage(config);
  app = await buildApp({ config, storage, provider, logger: false });
  profileId = (await app.inject({ method: "GET", url: "/api/profiles", headers })).json()
    .profiles[0].id;
  await app.inject({
    method: "PATCH",
    url: `/api/profiles/${profileId}`,
    headers,
    payload: { terminalMode: "basic", tools: ["terminal"] },
  });
  channelId = (
    await app.inject({
      method: "POST",
      url: "/api/channels",
      headers,
      payload: { name: "Usage", profileId },
    })
  ).json().channel.id;
});
afterEach(async () => {
  await app.close();
  rmSync(directory, { recursive: true, force: true });
});
async function wait(runId: string) {
  await vi.waitFor(async () =>
    expect(
      (await app.inject({ method: "GET", url: `/api/runs/${runId}/details`, headers })).json().run
        .status,
    ).not.toBe("running"),
  );
}
async function send(content: string) {
  const result = await app.inject({
    method: "POST",
    url: `/api/channels/${channelId}/messages`,
    headers,
    payload: { content },
  });
  expect(result.statusCode, result.payload).toBe(201);
  const id = result.json().run.id;
  await wait(id);
  return id;
}
async function report(query = "") {
  const response = await app.inject({ method: "GET", url: `/api/usage${query}`, headers });
  expect(response.statusCode, response.payload).toBe(200);
  return response.json();
}

describe("provider usage and cost reports", () => {
  it("retains a reported partial price when a later cumulative frame omits pricing", async () => {
    await send("partial-price");
    expect((await report()).totals).toMatchObject({
      runs: 1,
      totalTokens: 6,
      knownCostUsd: 0.003,
      incompleteCostRuns: 1,
      pricedCalls: 0,
    });
  });
  it("reconciles cumulative usage frames and multiple tool rounds, without treating an unpriced round as free", async () => {
    const job = (
      await app.inject({
        method: "POST",
        url: "/api/jobs",
        headers,
        payload: {
          name: "Metered job",
          schedule: "daily",
          timezone: "UTC",
          enabled: false,
          profileId,
          channelId,
          prompt: "priced tool",
        },
      })
    ).json().job;
    const original = (
      await app.inject({ method: "POST", url: `/api/jobs/${job.id}/run`, headers })
    ).json().execution.runId;
    await wait(original);
    const retry = (
      await app.inject({ method: "POST", url: `/api/runs/${original}/retry`, headers, payload: {} })
    ).json().run.id;
    await wait(retry);
    const result = await report();
    expect(result.totals).toMatchObject({
      runs: 2,
      completed: 2,
      promptTokens: 26,
      completionTokens: 14,
      totalTokens: 40,
      providerCalls: 4,
      reportedCalls: 4,
      pricedCalls: 2,
      incompleteCostRuns: 2,
      knownCostUsd: 0.004,
    });
    expect(result.byProfile[0].usage).toEqual(result.totals);
    expect(result.byJob).toHaveLength(1);
    expect(result.byJob[0]).toMatchObject({
      id: job.id,
      name: "Metered job",
      usage: result.totals,
    });
  });
  it("distinguishes zero price, missing usage and failed runs that already reported a price", async () => {
    await send("free");
    await send("missing");
    await send("failure");
    const result = await report();
    expect(result.totals).toMatchObject({
      runs: 3,
      completed: 2,
      failed: 1,
      runsWithUsage: 2,
      runsWithoutUsage: 1,
      totalTokens: 8,
      knownCostUsd: 0.005,
      incompleteCostRuns: 1,
      pricedCalls: 2,
      providerCalls: 3,
    });
    expect(result.byJob[0].name).toBe("Unscheduled runs");
  });
  it("separates demo/historical sources, validates dates, and requires authentication", async () => {
    const id = await send("free");
    updateRun(storage.db, id, {
      provider: "unknown",
      usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3, costUsd: 0 },
    });
    expect((await report()).totals.runs).toBe(0);
    expect((await report("?provider=unknown")).totals).toMatchObject({
      runs: 1,
      knownCostUsd: 0,
      incompleteCostRuns: 1,
    });
    updateRun(storage.db, id, { provider: "stub" });
    expect((await report("?provider=stub")).totals.runs).toBe(1);
    expect(
      (await report("?provider=all&from=2100-01-01T00:00:00Z&to=2100-02-01T00:00:00Z")).totals.runs,
    ).toBe(0);
    expect((await app.inject({ method: "GET", url: "/api/usage" })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: "GET", url: "/api/usage?from=bad", headers })).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/usage?from=2100-01-01T00:00:00Z&to=2000-01-01T00:00:00Z",
          headers,
        })
      ).statusCode,
    ).toBe(400);
  });
});
