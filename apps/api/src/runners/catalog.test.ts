import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, runMigrations } from "@vektor/db";
import { AgentCatalog, parseRegistry, REGISTRY_URL } from "./catalog.js";
const agent = {
  id: "test-agent",
  name: "Test",
  version: "1.2.3",
  description: "Test agent",
  authors: ["Publisher"],
  license: "MIT",
  distribution: { npx: { package: "test@1.2.3" } },
};
const registry = { version: "1.0.0", agents: [agent] };
let cleanup = () => {};
afterEach(() => cleanup());
describe("official ACP registry", () => {
  it("rejects schema drift, duplicate ids, missing distributions and malicious ids", () => {
    expect(parseRegistry(registry)).toHaveLength(1);
    for (const value of [
      { ...registry, version: "2.0.0" },
      { ...registry, agents: [agent, agent] },
      { ...registry, agents: [{ ...agent, id: "../../agent" }] },
      { ...registry, agents: [{ ...agent, distribution: {} }] },
    ])
      expect(() => parseRegistry(value)).toThrow();
  });
  it("persists last good snapshot when refresh fails and never launches metadata", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vektor-catalog-"));
    const { db, sqlite } = openDatabase(join(directory, "test.db"));
    cleanup = () => {
      sqlite.close();
      rmSync(directory, { recursive: true, force: true });
    };
    runMigrations(db);
    let fail = false;
    const fetcher = (async (url, options) => {
      expect(url).toBe(REGISTRY_URL);
      expect(options?.redirect).toBe("error");
      return fail ? new Response("bad", { status: 503 }) : Response.json(registry);
    }) as typeof fetch;
    const catalog = new AgentCatalog(db, fetcher);
    const snapshot = await catalog.sync();
    expect(snapshot.hash).toMatch(/^[a-f0-9]{64}$/);
    fail = true;
    await expect(catalog.sync()).rejects.toThrow();
    expect(new AgentCatalog(db).snapshot()).toEqual(snapshot);
  });
});

it.skipIf(!process.env.VEKTOR_LIVE_REGISTRY)(
  "accepts the current official registry without executing metadata",
  async () => {
    const response = await fetch(REGISTRY_URL, {
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
    expect(response.ok).toBe(true);
    expect(parseRegistry(await response.json()).length).toBeGreaterThan(1);
  },
);
