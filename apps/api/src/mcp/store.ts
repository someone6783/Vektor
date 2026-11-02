import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  appendAudit,
  deleteSetting,
  getSetting,
  listProfiles,
  setSetting,
  type VektorDatabase,
} from "@vektor/db";
import {
  mcpServerInputSchema,
  mcpServerSchema,
  mcpGrantSchema,
  type McpServer,
  type McpServerInput,
  type McpGrant,
  type McpDiscovery,
} from "@vektor/shared";
import { encryptSecret, decryptSecret } from "../secrets.js";
import { RuntimeError } from "../runtime/terminal.js";

function canonical(value: unknown, depth = 0): unknown {
  if (depth > 40) throw new RuntimeError("MCP metadata exceeds its nesting limit.", 413);
  if (Array.isArray(value)) return value.map((v) => canonical(v, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v, depth + 1)]),
    );
  return value;
}
export const hash = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
// Codex reserves mcp__/mcp. This broker prefix stays within the 64-character
// Responses tool-name limit while retaining the complete server UUID.
export const toolName = (serverId: string, name: string) =>
  `vektor_mcp_${serverId.replaceAll("-", "")}_${hash(name).slice(0, 20)}`;
export const secretInputSchema = z
  .object({
    values: z.record(z.string().min(8).max(16000)).refine((v) => Object.keys(v).length <= 20),
  })
  .strict();
const validEnvironmentName = (name: string) =>
  /^[A-Z][A-Z0-9_]{0,99}$/.test(name) &&
  !/^(PATH|HOME|TMPDIR|LANG|CODEX_HOME|NODE_OPTIONS|NODE_PATH|LD_.*|PYTHON.*|BASH_ENV|ENV|VEKTOR_.*|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)$/.test(
    name,
  );
export class McpStore {
  private readonly priorSecrets = new Set<string>();
  constructor(
    readonly db: VektorDatabase,
    private readonly key: Buffer,
  ) {}
  list(): McpServer[] {
    return z.array(mcpServerSchema).parse(getSetting(this.db, "mcp.servers") ?? []);
  }
  get(id: string): McpServer {
    const server = this.list().find((s) => s.id === id);
    if (!server) throw new RuntimeError("MCP server not found.", 404);
    return server;
  }
  private save(server: McpServer) {
    const servers = this.list(),
      index = servers.findIndex((s) => s.id === server.id);
    if (index < 0) servers.push(server);
    else servers[index] = server;
    setSetting(this.db, "mcp.servers", servers);
  }
  configure(input: McpServerInput, id?: string): McpServer {
    const parsed = mcpServerInputSchema.parse(input);
    const old = id ? this.get(id) : undefined;
    if (!old && this.list().length >= 20)
      throw new RuntimeError("At most twenty MCP servers can be configured.", 409);
    if (parsed.transport === "stdio") {
      for (const [name, value] of Object.entries(parsed.environment))
        if (!validEnvironmentName(name) || value.includes("\0"))
          throw new RuntimeError("Unsupported MCP environment variable.", 400);
      if (
        !parsed.hostBinaryAcknowledged ||
        !parsed.command.startsWith("/") ||
        parsed.command.includes("\0")
      )
        throw new RuntimeError(
          "Choose an absolute installed executable and explicitly allow its isolated launch.",
          400,
        );
      if (
        parsed.workingDirectory.startsWith("/") ||
        parsed.workingDirectory.split(/[\\/]/).includes("..") ||
        parsed.workingDirectory.includes("\0")
      )
        throw new RuntimeError(
          "MCP working directories must stay inside the Vektor workspace.",
          400,
        );
      if (parsed.url || parsed.allowLoopback)
        throw new RuntimeError(
          "Local servers use command arguments and separately granted network hosts.",
          400,
        );
    } else {
      let url: URL;
      try {
        url = new URL(parsed.url);
      } catch {
        throw new RuntimeError("Enter an MCP endpoint URL.", 400);
      }
      const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      if (
        url.username ||
        url.password ||
        url.hash ||
        url.search ||
        (url.protocol !== "https:" && !(local && parsed.allowLoopback && url.protocol === "http:"))
      )
        throw new RuntimeError(
          "Use HTTPS, or explicitly allow a loopback HTTP endpoint. Put credentials in protected headers.",
          400,
        );
      if (
        parsed.command ||
        parsed.args.length ||
        parsed.networkHosts.length ||
        Object.keys(parsed.environment).length ||
        parsed.workingDirectory !== "."
      )
        throw new RuntimeError(
          "Remote servers use only their endpoint and protected headers.",
          400,
        );
    }
    if (old) {
      this.remember(old.id);
      deleteSetting(this.db, `mcp.secrets.${old.id}`);
    }
    const server: McpServer = {
      ...parsed,
      id: old?.id ?? randomUUID(),
      revision: (old?.revision ?? 0) + 1,
      enabled: false,
      configuredSecretNames: [],
      discovery: null,
      health: {
        state: "untested",
        failures: 0,
        retryAt: 0,
        message: "Test this server before enabling it.",
        checkedAt: "",
      },
    };
    this.save(server);
    appendAudit(this.db, "mcp.configured", null, {
      serverId: server.id,
      revision: server.revision,
      transport: server.transport,
    });
    return server;
  }
  setCredentials(id: string, values: Record<string, string>): void {
    const server = this.get(id);
    for (const name of Object.keys(values)) {
      if (
        server.transport === "stdio"
          ? !validEnvironmentName(name)
          : !/^(authorization|x-[a-z0-9-]+)$/i.test(name)
      )
        throw new RuntimeError("Unsupported MCP credential variable or header name.", 400);
      if (server.transport === "http" && /[\r\n]/.test(values[name]!))
        throw new RuntimeError("Invalid credential header.", 400);
    }
    this.remember(id);
    if (Object.keys(values).length)
      setSetting(this.db, `mcp.secrets.${id}`, encryptSecret(JSON.stringify(values), this.key));
    else deleteSetting(this.db, `mcp.secrets.${id}`);
    for (const value of Object.values(values)) if (value) this.priorSecrets.add(value);
    this.save({
      ...server,
      revision: server.revision + 1,
      enabled: false,
      discovery: null,
      configuredSecretNames: Object.keys(values),
      health: {
        state: "untested",
        failures: 0,
        retryAt: 0,
        message: "Credentials changed. Test and grant access again.",
        checkedAt: "",
      },
    });
    appendAudit(this.db, "mcp.credentials_changed", null, {
      serverId: id,
      names: Object.keys(values),
    });
  }
  credentials(id: string): Record<string, string> {
    const raw = getSetting(this.db, `mcp.secrets.${id}`);
    if (typeof raw !== "string") return {};
    try {
      const values = z.record(z.string()).parse(JSON.parse(decryptSecret(raw, this.key)));
      for (const value of Object.values(values)) if (value) this.priorSecrets.add(value);
      return values;
    } catch {
      throw new RuntimeError(
        "This MCP server's protected values are unreadable. Replace them in Settings.",
        409,
      );
    }
  }
  private remember(id: string): void {
    try {
      this.credentials(id);
    } catch {
      /* A damaged credential must not block replacement/removal or native chat. */
    }
  }
  secrets(): string[] {
    for (const server of this.list()) this.remember(server.id);
    return [...this.priorSecrets].flatMap((value) => [value, JSON.stringify(value).slice(1, -1)]);
  }
  tested(id: string, discovery: McpDiscovery, executableHash?: string): McpServer {
    const names = discovery.tools.map((tool) => toolName(id, tool.name));
    if (new Set(names).size !== names.length)
      throw new RuntimeError(
        "MCP tool names collide after namespacing. This server cannot be enabled.",
        409,
      );
    const server = this.get(id);
    const changed =
      server.discovery &&
      (server.discovery.hash !== discovery.hash ||
        (executableHash !== undefined && server.executableHash !== executableHash));
    const updated = {
      ...server,
      revision: server.revision + (changed ? 1 : 0),
      enabled: changed ? false : server.enabled,
      discovery,
      ...(executableHash ? { executableHash } : {}),
      health: {
        state: "healthy" as const,
        failures: 0,
        retryAt: 0,
        message:
          "Protocol and discovery passed. Tools require explicit profile grants and approval.",
        checkedAt: new Date().toISOString(),
      },
    };
    this.save(updated);
    appendAudit(this.db, "mcp.tested", null, {
      serverId: id,
      hash: discovery.hash,
      changed: !!changed,
    });
    return updated;
  }
  failed(id: string): void {
    const server = this.get(id);
    const failures = Math.min(10, server.health.failures + 1);
    this.save({
      ...server,
      health: {
        state: "unavailable",
        failures,
        retryAt: Date.now() + Math.min(60_000, 1000 * 2 ** failures),
        message:
          "MCP connection failed. Check the server, compatibility and its separate credentials; reconnect explicitly.",
        checkedAt: new Date().toISOString(),
      },
    });
  }
  healthy(id: string): void {
    const server = this.get(id);
    this.save({
      ...server,
      health: {
        state: "healthy",
        failures: 0,
        retryAt: 0,
        message: "Last MCP connection completed successfully.",
        checkedAt: new Date().toISOString(),
      },
    });
  }
  resetHealth(id: string): void {
    const server = this.get(id);
    this.save({ ...server, health: { ...server.health, retryAt: 0 } });
  }
  enable(id: string, enabled: boolean): McpServer {
    const server = this.get(id);
    if (enabled && !server.discovery)
      throw new RuntimeError("Test the MCP server before enabling it.", 409);
    const updated = { ...server, enabled };
    this.save(updated);
    appendAudit(this.db, enabled ? "mcp.enabled" : "mcp.disabled", null, { serverId: id });
    return updated;
  }
  remove(id: string): void {
    this.get(id);
    this.remember(id);
    setSetting(
      this.db,
      "mcp.servers",
      this.list().filter((s) => s.id !== id),
    );
    deleteSetting(this.db, `mcp.secrets.${id}`);
    for (const profile of listProfiles(this.db))
      deleteSetting(this.db, `mcp.grant.${profile.id}.${id}`);
    appendAudit(this.db, "mcp.removed", null, { serverId: id });
  }
  grant(profileId: string, serverId: string): McpGrant {
    const stored = z
      .object({ revision: z.number(), grant: mcpGrantSchema })
      .safeParse(getSetting(this.db, `mcp.grant.${profileId}.${serverId}`));
    return stored.success && stored.data.revision === this.get(serverId).revision
      ? stored.data.grant
      : mcpGrantSchema.parse({});
  }
  setGrant(profileId: string, id: string, value: McpGrant): void {
    const server = this.get(id),
      grant = mcpGrantSchema.parse(value),
      discovery = server.discovery;
    if (!discovery) throw new RuntimeError("Test this MCP server before granting access.", 409);
    const others = this.list()
      .filter((s) => s.id !== id)
      .reduce((sum, s) => sum + this.grant(profileId, s.id).tools.length, 0);
    if (others + grant.tools.length > 64)
      throw new RuntimeError("Grant at most 64 MCP tools per profile.", 400);
    if (
      new Set(grant.tools.map((t) => t.name)).size !== grant.tools.length ||
      grant.tools.some((t) => !discovery.tools.some((s) => s.name === t.name)) ||
      grant.resources.some((uri) => !discovery.resources.some((r) => r.uri === uri)) ||
      grant.templates.some((uri) => !discovery.templates.some((r) => r.uriTemplate === uri)) ||
      grant.prompts.some((name) => !discovery.prompts.some((p) => p.name === name))
    )
      throw new RuntimeError("Grant only currently discovered MCP capabilities.", 400);
    if (
      grant.tools.some(
        (t) =>
          t.policy === "read-only" &&
          discovery.tools.find((s) => s.name === t.name)?.annotations?.readOnlyHint !== true,
      )
    )
      throw new RuntimeError(
        "An unknown or mutating tool requires the approval policy. Server hints never bypass approval.",
        400,
      );
    setSetting(this.db, `mcp.grant.${profileId}.${id}`, { revision: server.revision, grant });
    appendAudit(this.db, "mcp.grant_changed", null, { profileId, serverId: id, grant });
  }
  grants() {
    return listProfiles(this.db).flatMap((p) =>
      this.list().map((s) => ({
        profileId: p.id,
        serverId: s.id,
        revision: s.revision,
        grant: this.grant(p.id, s.id),
      })),
    );
  }
  policyHash(profileId: string): string {
    return hash(
      this.list()
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((s) => ({
          id: s.id,
          revision: s.revision,
          enabled: s.enabled,
          hash: s.discovery?.hash,
          grant: this.grant(profileId, s.id),
        })),
    );
  }
}
