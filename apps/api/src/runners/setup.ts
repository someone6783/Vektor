import { createHash } from "node:crypto";
import { createReadStream, realpathSync, statSync, existsSync } from "node:fs";
import { z } from "zod";
import {
  appendAudit,
  deleteSetting,
  getSetting,
  setSetting,
  type VektorDatabase,
} from "@vektor/db";
import { sandboxBase } from "../computer/sandbox.js";
import { RuntimeError } from "../runtime/terminal.js";
import { CodexSession, AcpSession } from "./protocol.js";

export const probeInputSchema = z
  .object({
    interface: z.enum(["codex-app-server", "acp-v1"]),
    command: z.string().min(1).max(4096).startsWith("/"),
    args: z.array(z.string().max(4096)).max(32).default([]),
  })
  .strict();
export type ProbeInput = z.infer<typeof probeInputSchema>;
export interface ProbeResult {
  interface: ProbeInput["interface"];
  command: string;
  args: string[];
  executableHash: string;
  checkedAt: string;
  protocolCompatible: boolean;
  executionAvailable: false;
  reason: string;
  agent: { name: string; version: string } | null;
}
export async function executableHash(command: string): Promise<string> {
  const stat = statSync(command);
  if (!stat.isFile() || stat.size > 512 * 1024 * 1024)
    throw new RuntimeError("Unsupported agent executable.");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(command)) hash.update(chunk);
  return hash.digest("hex");
}

// Probes execute untrusted code too. No network, backend data, host home, shared
// workspace or agent credentials are mounted. Only the supplied executable and
// system runtimes are visible; adjacent package trees are never shared.
export function isolatedProbe(command: string, args: string[]) {
  if (
    process.platform !== "linux" ||
    !existsSync("/usr/bin/bwrap") ||
    !existsSync("/usr/bin/prlimit")
  )
    throw new RuntimeError(
      "Runner probes require Linux, Bubblewrap and prlimit. Use a Linux backend.",
      409,
    );
  const executable = realpathSync(command);
  return {
    command: "/usr/bin/prlimit",
    args: [
      "--as=4294967296",
      "--cpu=10",
      "--nofile=128",
      "--fsize=16777216",
      "--",
      "/usr/bin/bwrap",
      ...sandboxBase(),
      "--dir",
      "/home/user/.codex",
      "--ro-bind",
      executable,
      "/run/agent",
      "--setenv",
      "HOME",
      "/home/user",
      "--setenv",
      "CODEX_HOME",
      "/home/user/.codex",
      "--setenv",
      "PATH",
      "/usr/bin:/bin",
      "--setenv",
      "LANG",
      "C.UTF-8",
      "--",
      "/run/agent",
      ...args,
    ],
    cwd: "/tmp",
    env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
  };
}

export class RunnerSetup {
  private probing = false;
  private controller?: AbortController;
  private session?: CodexSession | AcpSession;
  async stop(): Promise<void> {
    this.controller?.abort();
    await this.session?.close();
  }
  constructor(private readonly db: VektorDatabase) {}
  results(): ProbeResult[] {
    const stored = getSetting(this.db, "runner.probes");
    return Array.isArray(stored) ? (stored as ProbeResult[]) : [];
  }
  remove(hash: string): void {
    setSetting(
      this.db,
      "runner.probes",
      this.results().filter((entry) => entry.executableHash !== hash),
    );
    appendAudit(this.db, "runner.probe_removed", null, { executableHash: hash });
  }
  async probe(input: ProbeInput): Promise<ProbeResult> {
    if (this.probing) throw new RuntimeError("Another runner probe is active.", 409);
    if (getSetting(this.db, "runtime.emergencyStopped") === true)
      throw new RuntimeError("Emergency stop is active.", 423);
    this.probing = true;
    const controller = new AbortController();
    this.controller = controller;
    let session: CodexSession | AcpSession | undefined;
    try {
      const command = realpathSync(input.command);
      const hash = await executableHash(command);
      controller.signal.throwIfAborted();
      const args =
        input.interface === "codex-app-server"
          ? ["app-server", "--listen", "stdio://"]
          : input.args;
      const options = {
        ...isolatedProbe(command, args),
        timeoutMs: 8000,
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
        maxBytes: 1024 * 1024,
        event: () => {},
      };
      let agent: ProbeResult["agent"] = null;
      if (input.interface === "codex-app-server") {
        const codex = new CodexSession(options);
        session = codex;
        this.session = codex;
        const userAgent = await codex.initialize();
        const version = /\d+\.\d+\.\d+/.exec(userAgent)?.[0];
        if (!version) throw new RuntimeError("Codex did not identify a compatible version.", 409);
        agent = { name: "Codex", version };
      } else {
        const acp = new AcpSession(options);
        session = acp;
        this.session = acp;
        agent = await acp.initialize();
      }
      if ((await executableHash(command)) !== hash)
        throw new RuntimeError("Agent executable changed during probe.", 409);
      controller.signal.throwIfAborted();
      const result: ProbeResult = {
        interface: input.interface,
        command,
        args,
        executableHash: hash,
        checkedAt: new Date().toISOString(),
        protocolCompatible: true,
        executionAvailable: false,
        reason:
          "Protocol handshake passed. Verify and add this executable, configure its separate credential, enable it and grant a profile workspace/inference access before execution.",
        agent,
      };
      const previous = this.results().filter(
        (entry) => entry.command !== command || entry.interface !== input.interface,
      );
      setSetting(this.db, "runner.probes", [...previous.slice(-49), result]);
      appendAudit(this.db, "runner.probed", null, {
        interface: input.interface,
        executableHash: hash,
        agent,
        executionAvailable: false,
      });
      return result;
    } finally {
      await session?.close();
      this.session = undefined;
      this.controller = undefined;
      this.probing = false;
    }
  }
  clear(): void {
    deleteSetting(this.db, "runner.probes");
  }
}
