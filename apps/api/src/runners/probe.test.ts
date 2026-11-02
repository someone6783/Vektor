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
