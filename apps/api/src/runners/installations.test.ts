import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getSetting, openDatabase, runMigrations, setSetting } from "@vektor/db";
import { BrowserNetwork } from "../browser/network.js";
import { registryEntrySchema, REGISTRY_URL } from "./catalog.js";
import { RunnerInstallations } from "./installations.js";
import type { ProbeResult } from "./setup.js";
const digest = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
let cleanup = () => {};
afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "vektor-installation-"));
  const { db, sqlite } = openDatabase(join(directory, "db"));
  cleanup = () => {
    sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  };
  runMigrations(db);
  const command = join(directory, "agent.py");
  const code =
    "#!/usr/bin/python3\nraise RuntimeError('This file must not execute during verification')\n";
  writeFileSync(command, code, { mode: 0o700 });
  const tar = spawnSync("/usr/bin/tar", ["-czf", "-", "-C", directory, "./agent.py"]);
  expect(tar.status).toBe(0);
  const entry = registryEntrySchema.parse({
    id: "test-agent",
    name: "Test Agent",
    version: "1.0.0",
    description: "Controlled registry entry",
    authors: ["Test publisher"],
    license: "MIT",
    repository: "https://example.com/agent",
    distribution: {
      binary: {
        [process.arch === "arm64" ? "linux-aarch64" : "linux-x86_64"]: {
          archive: "https://example.com/agent.tar.gz",
          cmd: "./agent.py",
          sha256: digest(tar.stdout),
        },
      },
    },
  });
  setSetting(db, "runner.registry.snapshot", {
    source: REGISTRY_URL,
    checkedAt: new Date().toISOString(),
    hash: digest("registry"),
    agents: [entry],
  });
  const probe: ProbeResult = {
    interface: "acp-v1",
    command,
    args: [],
    executableHash: digest(code),
    checkedAt: new Date().toISOString(),
    protocolCompatible: true,
    executionAvailable: false,
    reason: "Probe only",
    agent: { name: "Test Agent", version: "1.0.0" },
  };
  const installs = new RunnerInstallations(db, directory, Buffer.alloc(32, 4));
  const request = vi
    .spyOn(BrowserNetwork.prototype, "request")
    .mockResolvedValue({ status: 200, headers: {}, body: tar.stdout });
  const input = {
    id: "acp:test-agent",
    executableHash: probe.executableHash,
    inferenceHosts: ["api.openai.com"],
    credentialName: "OPENAI_API_KEY" as const,
  };
  return { directory, db, probe, installs, request, input };
}
describe("explicit verified ACP setup", () => {
  it("compares the installed executable with the checksum-verified official archive and stays disabled", async () => {
    const { installs, probe, request, input } = fixture();
    const entry = await installs.configure(input, [probe]);
    expect(entry.enabled).toBe(false);
    expect(entry.source).toBe("https://example.com/agent");
    expect(existsSync(entry.command)).toBe(true);
    expect(request).toHaveBeenCalledOnce();
    expect(() => installs.enable(entry.id, true)).toThrow("credential");
  });
  it("rejects a tampered registry archive without enabling any agent", async () => {
    const { installs, probe, request, input } = fixture();
    request.mockResolvedValue({ status: 200, headers: {}, body: Buffer.from("tampered") });
    await expect(installs.configure(input, [probe])).rejects.toThrow("checksum");
    expect(installs.list()).toHaveLength(0);
  });
  it("keeps credentials encrypted and invalidates them when inference destinations change", async () => {
    const { installs, probe, input, db } = fixture();
    await installs.configure(input, [probe]);
    installs.setCredential(input.id, "dummy-agent-account-key");
    installs.enable(input.id, true);
    expect(String(getSetting(db, `runner.credentials.${input.id}`))).not.toContain(
      "dummy-agent-account-key",
    );
    await installs.configure({ ...input, inferenceHosts: ["api.anthropic.com"] }, [probe]);
    expect(installs.credential(input.id)).toBeUndefined();
    expect(installs.get(input.id)?.enabled).toBe(false);
    expect(installs.secrets()).toContain("dummy-agent-account-key");
  });
  it("rejects version drift before fetching an artifact", async () => {
    const { installs, probe, input, request } = fixture();
    await expect(
      installs.configure(input, [{ ...probe, agent: { name: "Test Agent", version: "9.0.0" } }]),
    ).rejects.toThrow("version");
    expect(request).not.toHaveBeenCalled();
  });
});
