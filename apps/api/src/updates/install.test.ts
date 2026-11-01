import { mkdtempSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapStorage, type Storage } from "../bootstrap.js";
import { loadConfig } from "../config.js";
import { UpdateService, RELEASE_API_URL } from "./service.js";
import { DesktopReleases, dockerUpdateState, queueDockerUpdate } from "./install.js";
import { buildApp } from "../app.js";

let directory: string;
let storage: Storage;
let updates: UpdateService;
const release = {
  tag_name: "v0.2.0",
  draft: false,
  prerelease: false,
  assets: [
    { id: 1, name: "Vektor_0.2.0_amd64.AppImage" },
    { id: 2, name: "Vektor_0.2.0_amd64.AppImage.sig" },
  ],
};
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "vektor-install-"));
  storage = bootstrapStorage(loadConfig({ NODE_ENV: "test", VEKTOR_DATA_DIR: directory }));
  updates = new UpdateService({
    db: storage.db,
    secretsKey: storage.secretsKey,
    repositoryPrivate: true,
    envEnabled: true,
    envToken: "private-test-token",
  });
});
afterEach(async () => {
  await updates.stop();
  if (storage.sqlite.open) storage.sqlite.close();
  rmSync(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
describe("signed desktop release proxy", () => {
  it("maps a signed AppImage to authenticated loopback URLs without exposing GitHub credentials", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async (url) =>
        url === RELEASE_API_URL ? Response.json(release) : new Response("fixture-signature"),
      );
    const proxy = new DesktopReleases(updates, fetchImpl);
    const manifest = await proxy.manifest("0.1.0", "http://127.0.0.1:8787");
    expect(manifest).toEqual({
      version: "0.2.0",
      url: "http://127.0.0.1:8787/api/desktop-update/assets/1",
      signature: "fixture-signature",
    });
    expect(JSON.stringify(manifest)).not.toContain("private-test-token");
    expect(fetchImpl.mock.calls[1]?.[1]?.headers).toMatchObject({
      Authorization: "Bearer private-test-token",
    });
    await expect(proxy.asset(999)).rejects.toThrow("Unknown release asset");
  });
  it("selects the Windows installer and signature independently of Linux assets", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (url) =>
      url === RELEASE_API_URL
        ? Response.json({
            ...release,
            assets: [
              ...release.assets,
              { id: 3, name: "Vektor_0.2.0_x64-setup.exe" },
              { id: 4, name: "Vektor_0.2.0_x64-setup.exe.sig" },
            ],
          })
        : new Response("windows-signature"),
    );
    const manifest = await new DesktopReleases(updates, fetchImpl).manifest(
      "0.1.0",
      "http://localhost:8787",
      "windows-x86_64",
    );
    expect(manifest).toMatchObject({
      url: "http://localhost:8787/api/desktop-update/assets/3",
      signature: "windows-signature",
    });
  });
  it("strips credentials on approved asset redirects and rejects other destinations", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(release))
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://release-assets.githubusercontent.com/file" },
        }),
      )
      .mockResolvedValueOnce(new Response("signed-binary"))
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: "https://evil.example/file" } }),
      );
    const proxy = new DesktopReleases(updates, fetchImpl);
    await proxy.asset(1);
    expect(fetchImpl.mock.calls[2]?.[1]).toMatchObject({ credentials: "omit", redirect: "error" });
    expect(fetchImpl.mock.calls[2]?.[1]?.headers).toBeUndefined();
    await expect(proxy.asset(1)).rejects.toThrow("Unexpected release asset redirect");
  });
  it("does not offer downgrades or unsigned releases and respects opt-out", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(release));
    const proxy = new DesktopReleases(updates, fetchImpl);
    expect(await proxy.manifest("0.2.0", "http://localhost:8787")).toBeNull();
    fetchImpl.mockResolvedValue(Response.json({ ...release, assets: [release.assets[0]] }));
    await expect(proxy.manifest("0.1.0", "http://localhost:8787")).rejects.toThrow("no signed");
    updates.configure({ enabled: false });
    await expect(proxy.manifest("0.1.0", "http://localhost:8787")).rejects.toThrow(
      "Enable update checks",
    );
  });
});
describe("Docker update queue", () => {
  it("requires a live helper and queues only a version and unique ID", async () => {
    vi.stubEnv("VEKTOR_UPDATE_DIR", directory);
    expect((await dockerUpdateState()).configured).toBe(false);
    await expect(queueDockerUpdate("0.2.0")).rejects.toThrow("unavailable");
    await writeFile(
      join(directory, "status.json"),
      JSON.stringify({ heartbeat: Date.now(), state: "idle", version: null, message: "Ready" }),
    );
    expect((await queueDockerUpdate("0.2.0")).state).toBe("queued");
    const request = JSON.parse(await readFile(join(directory, "request.json"), "utf8"));
    expect(Object.keys(request).sort()).toEqual(["id", "version"]);
    expect(request.version).toBe("0.2.0");
    await expect(queueDockerUpdate("0.2.0")).rejects.toThrow("already queued");
    await writeFile(
      join(directory, "status.json"),
      JSON.stringify({
        heartbeat: Date.now() - 31_000,
        state: "idle",
        version: null,
        message: "Ready",
      }),
    );
    expect((await dockerUpdateState()).configured).toBe(false);
  });
  it("latches emergency stop before queueing a clicked update and keeps it stopped", async () => {
    vi.stubEnv("VEKTOR_UPDATE_DIR", directory);
    await writeFile(
      join(directory, "status.json"),
      JSON.stringify({ heartbeat: Date.now(), state: "idle", version: null, message: "Ready" }),
    );
    const app = await buildApp({
      config: loadConfig({
        NODE_ENV: "test",
        VEKTOR_DATA_DIR: directory,
        VEKTOR_UPDATE_CHECK: "1",
      }),
      storage,
      logger: false,
      startScheduler: false,
      updateFetch: vi
        .fn<typeof fetch>()
        .mockImplementation(async () =>
          Response.json({ ...release, published_at: "2026-11-01T00:00:00Z" }),
        ),
    });
    const headers = { authorization: `Bearer ${storage.accessToken}` };
    try {
      const response = await app.inject({
        url: "/api/update-install",
        method: "POST",
        headers,
        payload: {},
      });
      expect(response.statusCode).toBe(202);
      expect((await app.inject({ url: "/api/runtime", headers })).json().emergencyStopped).toBe(
        true,
      );
      expect(JSON.parse(await readFile(join(directory, "request.json"), "utf8")).version).toBe(
        "0.2.0",
      );
    } finally {
      await app.close();
    }
  });
  it("requires authentication for update installation and desktop assets", async () => {
    const app = await buildApp({
      config: loadConfig({ NODE_ENV: "test", VEKTOR_DATA_DIR: directory }),
      storage,
      logger: false,
      startScheduler: false,
    });
    try {
      for (const url of [
        "/api/update-install",
        "/api/desktop-update/linux-x86_64/0.1.0",
        "/api/desktop-update/assets/1",
      ])
        expect((await app.inject({ url })).statusCode).toBe(401);
      expect(
        (await app.inject({ url: "/api/update-install", method: "POST", payload: {} })).statusCode,
      ).toBe(401);
      const headers = {
        authorization: `Bearer ${storage.accessToken}`,
        "x-vektor-backend": "http://evil.example",
      };
      expect(
        (await app.inject({ url: "/api/desktop-update/linux-x86_64/0.1.0", headers })).statusCode,
      ).toBe(400);
    } finally {
      await app.close();
    }
  });
});
