import { runnerIdSchema } from "@vektor/shared";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, copyFile, mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  appendAudit,
  deleteSetting,
  getSetting,
  listProfiles,
  setSetting,
  type VektorDatabase,
} from "@vektor/db";
import { BrowserNetwork } from "../browser/network.js";
import { encryptSecret, decryptSecret } from "../secrets.js";
import { RuntimeError } from "../runtime/terminal.js";
import { AgentCatalog, type RegistryEntry } from "./catalog.js";
import { executableHash, type ProbeResult } from "./setup.js";

const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export const grantSchema = z
  .object({
    runner: runnerIdSchema.optional(),
    workspace: z.boolean().default(false),
    inference: z.boolean().default(false),
  })
  .strict();
export type RunnerGrant = z.infer<typeof grantSchema>;
export const installationSchema = z.object({
  id: z.string(),
  name: z.string(),
  interface: z.enum(["codex-app-server", "acp-v1"]),
  version: z.string(),
  command: z.string(),
  args: z.array(z.string()),
  executableHash: z.string(),
  source: z.string(),
  sourceHash: z.string(),
  verifiedAt: z.string(),
  enabled: z.boolean(),
  inferenceHosts: z.array(z.string()),
  credentialName: z.string(),
});
export type Installation = z.infer<typeof installationSchema>;
export const configureRunnerSchema = z
  .object({
    id: z.string().regex(/^(codex|acp:[a-z0-9][a-z0-9._-]{0,99})$/),
    executableHash: z.string().regex(/^[a-f0-9]{64}$/),
    trustLocalCodex: z.literal(true).optional(),
    // A fixed host allowlist is a separate grant from browser network access.
    inferenceHosts: z
      .array(z.string().regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,}$/))
      .min(1)
      .max(5),
    credentialName: z.enum([
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "AMP_API_KEY",
      "MISTRAL_API_KEY",
    ]),
  })
  .strict();

async function extractExecutable(archive: Buffer, path: string): Promise<Buffer> {
  if (path.startsWith("/") || path.split("/").includes("..") || !/^[a-zA-Z0-9_./-]+$/.test(path))
    throw new RuntimeError("Unsafe registry executable path.", 409);
  return new Promise((resolve, reject) => {
    const child = spawn(
      "/usr/bin/prlimit",
      [
        "--as=1073741824",
        "--cpu=10",
        "--fsize=536870912",
        "--",
        "/usr/bin/python3",
        "-c",
        `
import sys,tarfile
wanted=sys.argv[1].removeprefix('./')
found=None; count=0; total=0
with tarfile.open(fileobj=sys.stdin.buffer,mode='r|*') as archive:
    for member in archive:
        count+=1; total+=member.size
        if count>5000 or total>536870912: raise ValueError('archive limit')
        if member.name.removeprefix('./')==wanted:
            if found is not None or not member.isfile() or member.size>536870912: raise ValueError('invalid executable')
            found=archive.extractfile(member).read()
if not found: raise ValueError('executable missing')
sys.stdout.buffer.write(found)
`,
        path,
      ],
      { shell: false, env: { PATH: "/usr/bin:/bin" }, stdio: ["pipe", "pipe", "ignore"] },
    );
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    child.stdin.on("error", () => {});
    child.on("error", reject);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 512 * 1024 * 1024) child.kill("SIGKILL");
      else chunks.push(chunk);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || !size || size > 512 * 1024 * 1024)
        reject(new RuntimeError("Registry archive could not be verified.", 409));
      else resolve(Buffer.concat(chunks));
    });
    child.stdin.end(archive);
  });
}
async function officialBinary(entry: RegistryEntry): Promise<Buffer> {
  const target =
    entry.distribution.binary?.[process.arch === "arm64" ? "linux-aarch64" : "linux-x86_64"];
  if (!target?.sha256)
    throw new RuntimeError(
      "This entry has no verifiable binary for this platform. Automatic package installation is unsupported.",
      409,
    );
  const signal = AbortSignal.timeout(60_000);
  const network = new BrowserNetwork({
    permissions: () => ({
      mode: "observe",
      session: "separate",
      display: "headless",
      allowedOrigins: ["*"],
      localOrigins: [],
    }),
    signal,
    redact: (value) => value,
  });
  let url = target.archive;
  for (let redirect = 0; redirect < 5; redirect++) {
    const response = await network.request(url, "GET", {}, undefined, 128 * 1024 * 1024);
    if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.location) {
      const next = new URL(response.headers.location, url);
      if (next.protocol !== "https:")
        throw new RuntimeError("Insecure registry artifact redirect.", 409);
      url = next.href;
      continue;
    }
    if (response.status !== 200 || digest(response.body) !== target.sha256)
      throw new RuntimeError("Official artifact checksum verification failed.", 409);
    if (/\.tar\.(gz|bz2|xz)$|\.tgz$/.test(new URL(target.archive).pathname))
      return extractExecutable(response.body, target.cmd);
    if (/\.zip$/.test(new URL(target.archive).pathname))
      throw new RuntimeError("ZIP agent packages are not supported by this backend.", 409);
    return response.body;
  }
  throw new RuntimeError("Too many registry artifact redirects.", 409);
}

export const runnerHealthSchema = z.object({
  state: z.enum(["unverified", "healthy", "authentication", "quota", "connection"]),
  failures: z.number().int().nonnegative(),
  retryAt: z.number().nonnegative(),
  checkedAt: z.string(),
});
export class RunnerInstallations {
  private readonly priorSecrets = new Set<string>();
  constructor(
    readonly db: VektorDatabase,
    private readonly dataDir: string,
    private readonly secretsKey: Buffer,
    readonly catalog = new AgentCatalog(db),
  ) {}
  compatibility(entry: Installation): { compatible: boolean; compatibilityReason: string } {
    if (entry.interface === "codex-app-server")
      return {
        compatible: entry.version === "0.166.0",
        compatibilityReason:
          "Local executable trust and Codex 0.166.0 protocol pin; effective controls are checked before each turn.",
      };
    const current = this.catalog.snapshot()?.agents.find((agent) => `acp:${agent.id}` === entry.id);
    const compatible =
      !!current &&
      current.version === entry.version &&
      digest(JSON.stringify(current)) === entry.sourceHash;
    return {
      compatible,
      compatibilityReason: compatible
        ? "Official archive and installed executable were verified; the executable hash is checked again before launch."
        : "Registry provenance or version changed. Explicitly re-verify this agent before running it.",
    };
  }
  health(id: string): z.infer<typeof runnerHealthSchema> {
    const parsed = runnerHealthSchema.safeParse(getSetting(this.db, `runner.health.${id}`));
    return parsed.success
      ? parsed.data
      : { state: "unverified", failures: 0, retryAt: 0, checkedAt: "" };
  }
  resetHealth(id: string): void {
    setSetting(this.db, `runner.health.${id}`, {
      state: "unverified",
      failures: 0,
      retryAt: 0,
      checkedAt: new Date().toISOString(),
    });
  }
  succeeded(id: string): void {
    setSetting(this.db, `runner.health.${id}`, {
      state: "healthy",
      failures: 0,
      retryAt: 0,
      checkedAt: new Date().toISOString(),
    });
  }
  failed(id: string, error: unknown): void {
    const failures = Math.min(10, this.health(id).failures + 1);
    const message = error instanceof Error ? error.message : "";
    const state = /authentication|credential|unauthorized/i.test(message)
      ? "authentication"
      : /quota|rate limit|usage limit/i.test(message)
        ? "quota"
        : "connection";
    setSetting(this.db, `runner.health.${id}`, {
      state,
      failures,
      retryAt: Date.now() + Math.min(60_000, 1000 * 2 ** failures),
      checkedAt: new Date().toISOString(),
    });
  }
  list(): Installation[] {
    const parsed = z
      .array(installationSchema)
      .safeParse(getSetting(this.db, "runner.installations") ?? []);
    return parsed.success
      ? parsed.data.map((entry) => ({
          ...entry,
          command: entry.command.endsWith(`/runners/${entry.executableHash}`)
            ? join(this.dataDir, "runners", entry.executableHash)
            : entry.command,
        }))
      : [];
  }
  get(id: string): Installation | undefined {
    return this.list().find((entry) => entry.id === id);
  }
  private save(entries: Installation[]) {
    setSetting(this.db, "runner.installations", entries);
  }
  async configure(
    input: z.infer<typeof configureRunnerSchema>,
    probes: ProbeResult[],
  ): Promise<Installation> {
    if (!this.get(input.id) && this.list().length >= 20)
      throw new RuntimeError("At most twenty external agents can be configured.", 409);
    const previous = this.get(input.id);
    const probe = probes.find(
      (entry) =>
        entry.executableHash === input.executableHash &&
        entry.protocolCompatible &&
        (input.id === "codex"
          ? entry.interface === "codex-app-server"
          : entry.interface === "acp-v1"),
    );
    if (!probe?.agent)
      throw new RuntimeError("Probe the installed executable before adding it.", 409);
    if ((await executableHash(probe.command)) !== probe.executableHash)
      throw new RuntimeError("Installed executable changed. Probe it again.", 409);
    let source: string;
    let sourceHash: string;
    let name: string;
    let args: string[];
    if (input.id === "codex") {
      if (!input.trustLocalCodex || probe.agent.version !== "0.166.0")
        throw new RuntimeError(
          "Only the verified Codex 0.166.0 interface is supported; explicitly confirm the local executable hash.",
          409,
        );
      if (
        input.credentialName !== "OPENAI_API_KEY" ||
        input.inferenceHosts.some((host) => host !== "api.openai.com")
      )
        throw new RuntimeError(
          "Codex supports separate OpenAI API-key authentication and api.openai.com egress only.",
          409,
        );
      source = "explicit-local-codex-trust";
      sourceHash = probe.executableHash;
      name = "Codex";
      args = [
        "app-server",
        "--listen",
        "stdio://",
        "-c",
        "features.shell_tool=false",
        "-c",
        "features.enable_request_compression=false",
        "-c",
        "features.unified_exec=false",
        "-c",
        "features.apps=false",
        "-c",
        "features.plugins=false",
        "-c",
        "features.browser_use=false",
        "-c",
        "features.computer_use=false",
        "-c",
        "features.multi_agent=false",
        "-c",
        'web_search="disabled"',
        "-c",
        "mcp_servers={}",
        "-c",
        'model_provider="vektor"',
        "-c",
        'model_providers.vektor.name="OpenAI"',
        "-c",
        'model_providers.vektor.base_url="https://api.openai.com/v1"',
        "-c",
        'model_providers.vektor.env_key="OPENAI_API_KEY"',
        "-c",
        'model_providers.vektor.wire_api="responses"',
        "-c",
        "model_providers.vektor.requires_openai_auth=false",
        "-c",
        "model_providers.vektor.supports_websockets=false",
        "-c",
        "model_providers.vektor.request_max_retries=0",
        "-c",
        "model_providers.vektor.stream_max_retries=0",
      ];
    } else {
      const registryId = input.id.slice(4);
      if (registryId === "codex-acp")
        throw new RuntimeError(
          "Select Codex's app-server entry; duplicate Codex interfaces are disabled.",
          409,
        );
      const entry = this.catalog.snapshot()?.agents.find((entry) => entry.id === registryId);
      if (!entry || entry.version !== probe.agent.version)
        throw new RuntimeError(
          "The probe version does not match the official registry snapshot.",
          409,
        );
      const binary = await officialBinary(entry);
      if (digest(binary) !== probe.executableHash)
        throw new RuntimeError(
          "The installed executable does not match the official registry artifact.",
          409,
        );
      source = entry.repository ?? entry.website ?? this.catalog.snapshot()!.source;
      sourceHash = digest(JSON.stringify(entry));
      name = entry.name;
      const target =
        entry.distribution.binary![process.arch === "arm64" ? "linux-aarch64" : "linux-x86_64"]!;
      args = target.args ?? [];
      if (JSON.stringify(args) !== JSON.stringify(probe.args))
        throw new RuntimeError(
          "Probe with the registry's exact argument array before enabling this agent.",
          409,
        );
    }
    const directory = join(this.dataDir, "runners");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const command = join(directory, probe.executableHash);
    const temporary = `${command}.${randomUUID()}.pending`;
    try {
      await copyFile(probe.command, temporary);
      await chmod(temporary, 0o500);
      if ((await executableHash(temporary)) !== probe.executableHash)
        throw new RuntimeError("Executable changed during verification.", 409);
      await rename(temporary, command);
    } finally {
      await rm(temporary, { force: true });
    }
    const installation: Installation = {
      id: input.id,
      name,
      interface: probe.interface,
      version: probe.agent.version,
      command,
      args,
      executableHash: probe.executableHash,
      source,
      sourceHash,
      verifiedAt: new Date().toISOString(),
      enabled: false,
      inferenceHosts: input.inferenceHosts,
      credentialName: input.credentialName,
    };
    if (
      previous &&
      (previous.credentialName !== installation.credentialName ||
        JSON.stringify(previous.inferenceHosts) !== JSON.stringify(installation.inferenceHosts))
    ) {
      this.credential(previous.id);
      deleteSetting(this.db, `runner.credentials.${previous.id}`);
      setSetting(
        this.db,
        `runner.authVersion.${previous.id}`,
        Number(getSetting(this.db, `runner.authVersion.${previous.id}`) ?? 0) + 1,
      );
    }
    this.save([...this.list().filter((entry) => entry.id !== input.id), installation]);
    this.resetHealth(input.id);
    if (
      previous &&
      previous.command !== command &&
      previous.command === join(this.dataDir, "runners", previous.executableHash) &&
      !this.list().some((entry) => entry.command === previous.command)
    )
      await rm(previous.command, { force: true });
    appendAudit(this.db, "runner.configured", null, {
      id: installation.id,
      executableHash: installation.executableHash,
      source,
      sourceHash,
      enabled: false,
    });
    return installation;
  }
  enable(id: string, enabled: boolean): Installation {
    const entry = this.get(id);
    if (!entry) throw new RuntimeError("Runner is not configured.", 404);
    if (enabled && !this.credential(id))
      throw new RuntimeError("Configure the separate agent credential before enabling it.", 409);
    const updated = { ...entry, enabled };
    this.save(this.list().map((item) => (item.id === id ? updated : item)));
    appendAudit(this.db, "runner.enablement_changed", null, { id, enabled });
    return updated;
  }
  async remove(id: string): Promise<void> {
    const entry = this.get(id);
    this.credential(id);
    this.save(this.list().filter((entry) => entry.id !== id));
    deleteSetting(this.db, `runner.credentials.${id}`);
    deleteSetting(this.db, `runner.health.${id}`);
    setSetting(
      this.db,
      `runner.authVersion.${id}`,
      Number(getSetting(this.db, `runner.authVersion.${id}`) ?? 0) + 1,
    );
    for (const profile of listProfiles(this.db, { includeArchived: true }))
      if (this.grant(profile.id).runner === id)
        deleteSetting(this.db, `runner.grant.${profile.id}`);
    if (
      entry &&
      entry.command === join(this.dataDir, "runners", entry.executableHash) &&
      !this.list().some((other) => other.command === entry.command)
    )
      await rm(entry.command, { force: true });
    appendAudit(this.db, "runner.removed", null, { id });
  }

  grant(profileId: string): RunnerGrant {
    return grantSchema.parse(getSetting(this.db, `runner.grant.${profileId}`) ?? {});
  }
  setGrant(profileId: string, grant: RunnerGrant): void {
    setSetting(this.db, `runner.grant.${profileId}`, grant);
    appendAudit(this.db, "runner.grant_changed", null, { profileId, grant });
  }
  credential(id: string): string | undefined {
    const stored = getSetting(this.db, `runner.credentials.${id}`);
    if (typeof stored !== "string") return undefined;
    try {
      const value = decryptSecret(stored, this.secretsKey);
      this.priorSecrets.add(value);
      return value;
    } catch {
      return undefined;
    }
  }
  setCredential(id: string, key: string | null): void {
    this.credential(id);
    this.resetHealth(id);
    if (!this.get(id)) throw new RuntimeError("Runner is not configured.", 404);
    if (key === null) deleteSetting(this.db, `runner.credentials.${id}`);
    else setSetting(this.db, `runner.credentials.${id}`, encryptSecret(key, this.secretsKey));
    setSetting(
      this.db,
      `runner.authVersion.${id}`,
      Number(getSetting(this.db, `runner.authVersion.${id}`) ?? 0) + 1,
    );
    appendAudit(this.db, "runner.credential_changed", null, { id, configured: key !== null });
  }
  secrets(): string[] {
    return [...this.list().map((entry) => this.credential(entry.id) ?? ""), ...this.priorSecrets];
  }
  async verifyExecutable(entry: Installation): Promise<void> {
    if ((await executableHash(entry.command)) !== entry.executableHash)
      throw new RuntimeError(
        "The managed runner binary changed. Re-verify it before execution.",
        409,
      );
  }
}
