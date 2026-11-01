import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp, type VektorApp } from "../app.js";
import { bootstrapStorage } from "../bootstrap.js";
import { loadConfig } from "../config.js";
import { browserDesktop } from "./desktop.js";
import type { BrowserSessionOptions } from "./controller.js";

let directory: string;
let app: VektorApp;
let profileId: string;
let channelId: string;
let sessionOptions: BrowserSessionOptions | undefined;
let available: boolean;
let started: boolean;
let paused: boolean;
let focused: number;
const headers = { authorization: "Bearer visible-window-api-test-token" };
async function open() {
  const config = loadConfig({
    NODE_ENV: "test",
    VEKTOR_DATA_DIR: directory,
    VEKTOR_ACCESS_TOKEN: "visible-window-api-test-token",
  });
  app = await buildApp({
    config,
    storage: bootstrapStorage(config),
    logger: false,
    startScheduler: false,
    browserDesktop: browserDesktop(available ? { DISPLAY: ":test" } : {}, "linux"),
    provider: {
      async *streamChat(request) {
        await new Promise<void>((resolve) =>
          request.signal?.addEventListener("abort", () => resolve(), { once: true }),
        );
        yield { type: "finish", reason: "stop" };
      },
    },
    browserFactory: (options) => {
      sessionOptions = options;
      return {
        execute: async () => {
          started = true;
          return {};
        },
        focus: async () => {
          focused++;
        },
        state: () => ({
          mode: options.permissions().mode,
          display: "window",
          phase: started ? "active" : "closed",
          active: started,
          paused,
          sensitive: false,
          url: "about:blank",
          tabs: [],
          actions: 0,
          snapshot: "",
        }),
        pause: (value) => {
          paused = value;
        },
        close: async () => {
          started = false;
        },
      };
    },
  });
  profileId = (await app.inject({ url: "/api/profiles", headers })).json().profiles[0].id;
  channelId = (
    await app.inject({
      url: "/api/channels",
      method: "POST",
      headers,
      payload: { name: "Visible test", profileId },
    })
  ).json().channel.id;
}
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "vektor-window-api-"));
  available = true;
  started = false;
  paused = false;
  focused = 0;
  sessionOptions = undefined;
  await open();
});
afterEach(async () => {
  await app.close();
  rmSync(directory, { recursive: true, force: true });
});
async function run(enabled = true) {
  if (enabled)
    await app.inject({
      url: `/api/profiles/${profileId}`,
      method: "PATCH",
      headers,
      payload: { browser: { mode: "observe", display: "window", session: "separate" } },
    });
  return (
    await app.inject({
      url: `/api/channels/${channelId}/messages`,
      method: "POST",
      headers,
      payload: { content: "Keep the browser run open" },
    })
  ).json().run.id as string;
}
const control = (id: string, action: string) =>
  app.inject({
    url: `/api/runs/${id}/browser/control`,
    method: "POST",
    headers,
    payload: { action },
  });
describe("visible browser run controls", () => {
  it("authenticates capability reporting and opens/focuses a window from the run UI", async () => {
    expect((await app.inject({ url: "/api/browser/capabilities" })).statusCode).toBe(401);
    expect(
      (await app.inject({ url: "/api/browser/capabilities", headers })).json()
        .visibleWindowAvailable,
    ).toBe(true);
    const id = await run();
    expect(
      (await app.inject({ url: `/api/runs/${id}/details`, headers })).json().browser,
    ).toMatchObject({ display: "window", mode: "observe", active: false });
    expect(
      (
        await app.inject({
          url: `/api/runs/${id}/browser/control`,
          method: "POST",
          payload: { action: "open" },
        })
      ).statusCode,
    ).toBe(401);
    expect((await control(id, "open")).statusCode).toBe(200);
    expect(focused).toBe(1);
    expect(
      (await app.inject({ url: `/api/runs/${id}/browser`, headers })).json().session,
    ).toMatchObject({ display: "window", active: true });
    expect((await control(id, "focus")).statusCode).toBe(200);
    expect(focused).toBe(2);
    expect((await control(id, "pause")).statusCode).toBe(200);
    expect(paused).toBe(true);
    expect((await control(id, "close")).statusCode).toBe(200);
    expect(started).toBe(false);
  });
  it("keeps closed windows closed instead of automatically relaunching them", async () => {
    const id = await run();
    await control(id, "open");
    started = false;
    sessionOptions!.onWindowClosed?.();
    await vi.waitFor(async () =>
      expect(
        (await app.inject({ url: `/api/runs/${id}/browser`, headers })).json().session.active,
      ).toBe(false),
    );
    expect((await control(id, "open")).statusCode).toBe(409);
  });
  it("refuses opening when the profile is disabled or the backend has no display", async () => {
    const disabled = await run(false);
    expect((await control(disabled, "open")).statusCode).toBe(403);
    await app.close();
    available = false;
    await open();
    const id = await run();
    const response = await control(id, "open");
    expect(response.statusCode).toBe(409);
    expect(response.body).toContain("no desktop display");
    expect(sessionOptions).toBeUndefined();
    expect(started).toBe(false);
  });
});
