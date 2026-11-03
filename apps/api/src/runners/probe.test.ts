import { expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, runMigrations } from "@vektor/db";
import { RunnerSetup } from "./setup.js";
it.skipIf(!process.env.VEKTOR_CODEX_PROBE_BIN)(
  "initializes real Codex in a networkless isolated filesystem",
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "vektor-probe-"));
    const { db, sqlite } = openDatabase(join(directory, "test.db"));
    try {
      runMigrations(db);
      const result = await new RunnerSetup(db).probe({
        interface: "codex-app-server",
        command: process.env.VEKTOR_CODEX_PROBE_BIN!,
        args: [],
      });
      expect(result.agent?.name).toBe("Codex");
      expect(result.protocolCompatible).toBe(true);
      expect(result.executionAvailable).toBe(false);
    } finally {
      sqlite.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
  15_000,
);

it.skipIf(!process.env.VEKTOR_CODEX_PROBE_BIN)(
  "verifies real Codex effective controls and creates a broker-ready thread without an inference turn",
  async () => {
    const { RunnerInstallations } = await import("./installations.js");
    const { isolatedRunner } = await import("./isolation.js");
    const { CodexSession } = await import("./protocol.js");
    const directory = mkdtempSync(join(tmpdir(), "vektor-codex-controls-"));
    const { db, sqlite } = openDatabase(join(directory, "test.db"));
    let isolated: Awaited<ReturnType<typeof isolatedRunner>> | undefined;
    let session: InstanceType<typeof CodexSession> | undefined;
    try {
      runMigrations(db);
      const setup = new RunnerSetup(db);
      const probe = await setup.probe({
        interface: "codex-app-server",
        command: process.env.VEKTOR_CODEX_PROBE_BIN!,
        args: [],
      });
      const installs = new RunnerInstallations(db, directory, Buffer.alloc(32, 1));
      const entry = await installs.configure(
        {
          id: "codex",
          executableHash: probe.executableHash,
          trustLocalCodex: true,
          inferenceHosts: ["api.openai.com"],
          credentialName: "OPENAI_API_KEY",
        },
        [probe],
      );
      isolated = await isolatedRunner({
        command: entry.command,
        args: entry.args,
        hosts: [],
        credentials: { OPENAI_API_KEY: "dummy-never-used-for-inference" },
        signal: AbortSignal.timeout(15_000),
      });
      session = new CodexSession({ ...isolated, verifyControls: true, event: () => {} });
      await session.initialize();
      await session.verifyControls();
      const id = await session.create({
        model: "gpt-6.1-sol",
        cwd: "/workspace",
        approvalPolicy: "untrusted",
        sandbox: "read-only",
        baseInstructions: "Controlled protocol test",
        dynamicTools: [
          {
            name: "vektor_test",
            description: "Controlled test tool",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      });
      expect(id.length).toBeGreaterThan(0);
    } finally {
      await session?.close();
      await isolated?.close();
      sqlite.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
  25_000,
);

it.skipIf(!process.env.VEKTOR_OPENCODE_PROBE_BIN)(
  "initializes real OpenCode ACP without credentials, network or a model request",
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "vektor-opencode-probe-"));
    const { db, sqlite } = openDatabase(join(directory, "test.db"));
    try {
      runMigrations(db);
      const result = await new RunnerSetup(db).probe({
        interface: "acp-v1",
        command: process.env.VEKTOR_OPENCODE_PROBE_BIN!,
        args: ["acp"],
      });
      expect(result.agent?.name.toLowerCase()).toContain("opencode");
      expect(result.protocolCompatible).toBe(true);
      expect(result.executionAvailable).toBe(false);
    } finally {
      sqlite.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
  15_000,
);

it.skipIf(!process.env.VEKTOR_OPENCODE_PROBE_BIN)(
  "creates a real OpenCode free-model session without saved login or API keys",
  async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { isolatedRunner } = await import("./isolation.js");
    const { stageNativeAccount } = await import("./native.js");
    const { AcpSession } = await import("./protocol.js");
    const home = await mkdtemp("/dev/shm/vektor-opencode-free-");
    let isolated: Awaited<ReturnType<typeof isolatedRunner>> | undefined;
    let session: InstanceType<typeof AcpSession> | undefined;
    try {
      await stageNativeAccount(home, { runner: "opencode", auth: {}, hosts: ["opencode.ai"] });
      isolated = await isolatedRunner({
        command: process.env.VEKTOR_OPENCODE_PROBE_BIN!,
        args: ["acp"],
        hosts: ["opencode.ai"],
        credentials: { OPENCODE_DISABLE_AUTOUPDATE: "true", OPENCODE_DISABLE_MODELS_FETCH: "true" },
        signal: AbortSignal.timeout(30000),
        home,
      });
      session = new AcpSession({ ...isolated, timeoutMs: 20000, event: () => {} });
      await session.initialize();
      expect(await session.create("/workspace")).toBeTruthy();
      expect(await session.selectModel("agent-default")).toMatch(/^opencode\//);
    } finally {
      await session?.close();
      await isolated?.close();
      await rm(home, { recursive: true, force: true });
    }
  },
  35000,
);

it.skipIf(!process.env.VEKTOR_CODEX_PROBE_BIN)(
  "loads the installed Codex model catalog without a workspace or inference request",
  async () => {
    const { isolatedProbe } = await import("./setup.js");
    const { CodexSession } = await import("./protocol.js");
    const session = new CodexSession({
      ...isolatedProbe(process.env.VEKTOR_CODEX_PROBE_BIN!, ["app-server", "--listen", "stdio://"]),
      timeoutMs: 10000,
      event: () => {},
    });
    try {
      await session.initialize();
      const result = await session.models();
      expect(result.models.length).toBeGreaterThan(0);
      expect(result.models.some((model) => model.id === result.defaultModel)).toBe(true);
      expect(result.models.every((model) => model.name.length > 0)).toBe(true);
    } finally {
      await session.close();
    }
  },
  15000,
);
