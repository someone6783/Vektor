import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSetting } from "@vektor/db";
import { updateCheckSchema } from "@vektor/shared";
import { bootstrapStorage, type Storage } from "../bootstrap.js";
import { loadConfig } from "../config.js";
import { buildApp } from "../app.js";
import {
  newerRelease,
  releaseVersion,
  RELEASE_API_URL,
  UPDATE_CACHE_MS,
  UpdateService,
} from "./service.js";

let directory: string;
let storage: Storage;
let now: number;
const release = (tag = "v0.2.0") => ({
  tag_name: tag,
  draft: false,
  prerelease: false,
  published_at: "2026-11-01T00:00:00Z",
});
const response = (tag = "v0.2.0") => Response.json(release(tag));
const services: UpdateService[] = [];
function service(extra: Partial<ConstructorParameters<typeof UpdateService>[0]> = {}) {
  const value = new UpdateService({
    db: storage.db,
    secretsKey: storage.secretsKey,
    repositoryPrivate: false,
    currentVersion: "0.1.0",
    now: () => now,
    ...extra,
  });
  services.push(value);
  return value;
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "vektor-updates-"));
  storage = bootstrapStorage(loadConfig({ NODE_ENV: "test", VEKTOR_DATA_DIR: directory }));
  now = Date.parse("2026-11-01T00:00:00Z");
});
afterEach(async () => {
  await Promise.all(services.splice(0).map((value) => value.stop()));
  if (storage.sqlite.open) storage.sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("strict release versions", () => {
  it.each([
    ["0.1.0", "0.1.0", false],
    ["0.1.0", "0.2.0", true],
    ["0.2.0", "0.1.0", false],
    ["0.1.0", "0.10.0", true],
    ["0.1.0+build.1", "0.2.0+build.2", true],
    ["0.1.0", "0.2.0-beta.1", false],
    ["0.2.0-beta.1", "0.2.0", true],
    ["0.1.0+build.1", "0.1.0+build.2", false],
    ["invalid", "0.2.0", false],
    ["0.1.0", "01.2.0", false],
    ["0.1.0", "v0.2.0", false],
  ])("compares %s to %s", (current, latest, expected) =>
    expect(newerRelease(current, latest)).toBe(expected),
  );
  it.each(["latest", "v01.2.0", "v1.2", " v1.2.3", "vv1.2.3", "1.2.3\n"])("rejects %j", (tag) =>
    expect(releaseVersion(tag)).toBeNull(),
  );
});

describe("release fetching and persistence", () => {
  it("sends only the app User-Agent to a fixed GitHub endpoint and constructs the release link", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ ...release(), html_url: "https://evil.example/", body: "untrusted" }),
      );
    const result = await service({ fetchImpl, envToken: "must-not-be-sent-for-public" }).check();
    expect(result).toMatchObject({
      updateAvailable: true,
      latestVersion: "0.2.0",
      status: "available",
      cached: false,
      publishedAt: release().published_at,
    });
    expect(result.releaseUrl).toBe("https://github.com/someone6783/Vektor/releases/tag/v0.2.0");
    expect(fetchImpl).toHaveBeenCalledWith(
      RELEASE_API_URL,
      expect.objectContaining({
        redirect: "error",
        credentials: "omit",
        headers: { "User-Agent": "Vektor/0.1.0" },
      }),
    );
    expect(updateCheckSchema.safeParse(result).success).toBe(true);
  });
  it("persists the 24 hour cache across service restart, expires it, and supports manual refresh", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => response());
    await service({ fetchImpl }).check();
    const restarted = service({ fetchImpl });
    now += UPDATE_CACHE_MS - 1;
    expect((await restarted.check()).cached).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now++;
    await restarted.check();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await restarted.check(true);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
  it.each([403, 429, 404])("quietly caches HTTP %s without retrying", async (status) => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("private response", { status }));
    const updates = service({ fetchImpl });
    expect((await updates.check()).error).toBe(status === 404 ? "not_found" : "rate_limited");
    await updates.check();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it.each([
    { ...release(), prerelease: true },
    { ...release(), draft: true },
    release("v0.2.0-beta.1"),
    release("v01.2.0"),
    { ...release(), published_at: "tomorrow" },
    {},
  ])("rejects malformed or prerelease-only results %j", async (value) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(value));
    expect((await service({ fetchImpl }).check()).error).toBe("invalid_response");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it.each(["not JSON", "x".repeat(65 * 1024)])(
    "bounds and rejects invalid response bodies",
    async (body) => {
      expect((await service({ fetchImpl: async () => new Response(body) }).check()).error).toBe(
        "invalid_response",
      );
    },
  );
  it("retries a network failure once and caches failure without throwing", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error("secret remote body"));
    const updates = service({ fetchImpl });
    const result = await updates.check();
    expect(result.error).toBe("offline");
    expect(JSON.stringify(result)).not.toContain("secret");
    await updates.check();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it("recovers from a server error on the single retry", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(response());
    expect((await service({ fetchImpl }).check()).updateAvailable).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it("times out attempts and stops an in-flight check", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    );
    const updates = service({ fetchImpl, timeoutMs: 15 });
    expect((await updates.check()).error).toBe("offline");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const running = updates.check(true);
    await updates.stop();
    await expect(running).resolves.toMatchObject({ error: "offline" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
  it("deduplicates simultaneous callers and discards a result after opt-out", async () => {
    let resolve!: (response: Response) => void;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const updates = service({ fetchImpl });
    const a = updates.check();
    const b = updates.check(true);
    updates.configure({ enabled: false });
    resolve(response());
    expect((await a).status).toBe("disabled");
    expect((await b).updateAvailable).toBe(false);
    expect(getSetting(storage.db, "updates.result")).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("optional private credentials", () => {
  it("makes no requests while opted out, including forced requests", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const updates = service({ envEnabled: false, fetchImpl });
    expect((await updates.check(true)).status).toBe("disabled");
    expect(() => updates.configure({ enabled: true })).toThrow(/disabled/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("defaults private checks off and stores a write-only encrypted token", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => response());
    const updates = service({ repositoryPrivate: true, fetchImpl });
    expect((await updates.check(true)).enabled).toBe(false);
    updates.configure({ enabled: true });
    expect((await updates.check()).error).toBe("token_required");
    expect(fetchImpl).not.toHaveBeenCalled();
    const token = "github-read-only-test-token";
    expect(JSON.stringify(updates.configure({ githubToken: token }))).not.toContain(token);
    expect(String(getSetting(storage.db, "updates.githubToken"))).not.toContain(token);
    expect((await updates.check()).tokenSource).toBe("stored");
    expect(fetchImpl).toHaveBeenCalledWith(
      RELEASE_API_URL,
      expect.objectContaining({
        headers: { "User-Agent": "Vektor/0.1.0", Authorization: `Bearer ${token}` },
      }),
    );
    updates.configure({ githubToken: null });
    expect((await updates.check(true)).error).toBe("token_required");
  });
  it("treats an environment token as write-only and managed", () => {
    const updates = service({ envToken: "environment-test-token" });
    expect(updates.snapshot().tokenSource).toBe("env");
    expect(() => updates.configure({ githubToken: null })).toThrow(/environment/);
    expect(JSON.stringify(updates.snapshot())).not.toContain("environment-test-token");
  });
  it("authenticates update routes, validates inputs, and leaves health available offline", async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      VEKTOR_DATA_DIR: directory,
      VEKTOR_UPDATE_CHECK: "1",
      VEKTOR_GITHUB_TOKEN: "github-test-token",
    });
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"));
    const app = await buildApp({
      config,
      storage,
      logger: false,
      updateFetch: fetchImpl,
      startScheduler: false,
    });
    try {
      expect((await app.inject({ url: "/api/update-check" })).statusCode).toBe(401);
      const headers = { authorization: `Bearer ${storage.accessToken}` };
      expect((await app.inject({ url: "/api/update-check?force=1", headers })).statusCode).toBe(
        400,
      );
      const result = await app.inject({ url: "/api/update-check", headers });
      expect(result.statusCode).toBe(200);
      expect(result.json().error).toBe("offline");
      expect((await app.inject({ url: "/healthz" })).statusCode).toBe(200);
      expect(
        (
          await app.inject({
            url: "/api/update-check",
            method: "PUT",
            headers,
            payload: { githubToken: "bad\nheader" },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            url: "/api/update-check",
            method: "PUT",
            headers,
            payload: { enabled: false },
          })
        ).json().status,
      ).toBe("disabled");
    } finally {
      await app.close();
    }
  });
});
