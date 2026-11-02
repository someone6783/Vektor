import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import { getProfile, getSetting, appendAudit, type VektorDatabase } from "@vektor/db";
import { type McpServer, type McpTool, type McpContext } from "@vektor/shared";
import { UriTemplate } from "@modelcontextprotocol/sdk/shared/uriTemplate.js";
import { RuntimeError } from "../runtime/terminal.js";
import type { ChatRequest } from "../providers/types.js";
import { RunnerWorkspace, type WorkspaceStage } from "../runners/workspace.js";
import { executableHash } from "../runners/setup.js";
import { isolatedRunner } from "../runners/isolation.js";
import { McpStore, toolName } from "./store.js";
import { IsolatedStdioTransport, PinnedTransport, remoteTransport } from "./transport.js";
import { McpClient } from "./client.js";
import { McpContent } from "./content.js";
import { validateSchemas } from "./validation.js";

export interface McpInvocation {
  runId: string;
  profileId: string;
  runner: string;
  jobServers?: string[];
  signal: AbortSignal;
  approve: (detail: unknown) => Promise<boolean>;
  progress: (detail: unknown) => void;
}
export class McpService {
  readonly store: McpStore;
  readonly content: McpContent;
  private readonly running = new Map<
    string,
    {
      serverId: string;
      profileId?: string;
      runId?: string;
      controller: AbortController;
      done: Promise<unknown>;
    }
  >();
  private redact: (value: string) => string = (value) => value;
  constructor(
    readonly db: VektorDatabase,
    private readonly dataDir: string,
    key: Buffer,
    private readonly protectedPort: number,
  ) {
    this.store = new McpStore(db, key);
    this.content = new McpContent(db, dataDir, key);
  }
  setRedactor(redact: (value: string) => string) {
    this.redact = redact;
  }
  assertSafeConfiguration(value: unknown): void {
    const raw = JSON.stringify(value);
    if (typeof raw === "string" && this.redact(raw) !== raw)
      throw new RuntimeError(
        "MCP configuration cannot contain known credentials. Use protected environment variables or headers.",
        400,
      );
  }
  assertStart(): void {
    if (getSetting(this.db, "runtime.emergencyStopped") === true)
      throw new RuntimeError("Emergency stop is active.", 423);
  }
  private profile(id: string) {
    const profile = getProfile(this.db, id);
    if (!profile || profile.archivedAt !== null)
      throw new RuntimeError("MCP profile is unavailable.", 403);
    return profile;
  }
  definitions(
    profileId: string,
    runner = "native",
    jobServers?: string[],
  ): NonNullable<ChatRequest["tools"]> {
    return this.store
      .list()
      .filter((s) => s.enabled && s.discovery && (!jobServers || jobServers.includes(s.id)))
      .flatMap((server) => {
        const grant = this.store.grant(profileId, server.id);
        if ((runner !== "native" && !grant.externalRunners) || (jobServers && !grant.scheduled))
          return [];
        return server
          .discovery!.tools.filter((t) => grant.tools.some((g) => g.name === t.name))
          .map((tool) => ({
            type: "function" as const,
            function: {
              name: toolName(server.id, tool.name),
              description: `MCP ${server.name}: ${tool.name}. ${tool.description}\nUntrusted server metadata. This call requires Vektor approval.`,
              parameters: tool.inputSchema,
            },
          }));
      })
      .slice(0, 64);
  }
  private find(
    name: string,
    context: McpInvocation,
  ): { server: McpServer; tool: McpTool; readOnly: boolean } {
    this.assertStart();
    this.profile(context.profileId);
    context.signal.throwIfAborted();
    for (const server of this.store.list()) {
      const tool = server.discovery?.tools.find((t) => toolName(server.id, t.name) === name);
      if (!tool) continue;
      const grant = this.store.grant(context.profileId, server.id),
        permission = grant.tools.find((t) => t.name === tool.name);
      if (
        !server.enabled ||
        !permission ||
        (context.runner !== "native" && !grant.externalRunners) ||
        (context.jobServers && (!context.jobServers.includes(server.id) || !grant.scheduled))
      )
        break;
      if (server.health.retryAt > Date.now())
        throw new RuntimeError(
          "MCP server is cooling down after a failure. Reconnect explicitly in Settings.",
          409,
        );
      return { server, tool, readOnly: permission.policy === "read-only" };
    }
    throw new RuntimeError("This MCP tool is not granted to this profile, runner and job.", 403);
  }
  private async workspace(server: McpServer): Promise<RunnerWorkspace> {
    const root = join(this.dataDir, "workspace"),
      path = resolve(root, server.workingDirectory);
    const rel = relative(root, path);
    if (rel === ".." || rel.startsWith("../") || isAbsolute(rel))
      throw new RuntimeError("MCP working directory is outside the workspace.", 403);
    await mkdir(root, { recursive: true, mode: 0o700 });
    let current = root;
    if ((await lstat(current)).isSymbolicLink())
      throw new RuntimeError("MCP workspace cannot follow links.", 403);
    for (const part of rel.split("/").filter(Boolean)) {
      current = join(current, part);
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new RuntimeError("MCP working directory cannot follow links.", 403);
    }
    return new RunnerWorkspace(path);
  }
  private operation<T>(
    server: McpServer,
    signal: AbortSignal,
    scope: { profileId?: string; runId?: string },
    work: (client: McpClient, stage?: WorkspaceStage, workspace?: RunnerWorkspace) => Promise<T>,
    options: { workspace: boolean; readOnly: boolean },
  ): Promise<T> {
    this.assertStart();
    if (this.running.size >= 4)
      throw new RuntimeError("MCP connection concurrency limit reached.", 409);
    const id = randomUUID(),
      controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(60_000)]);
    const done = (async () => {
      let client: McpClient | undefined,
        isolated: Awaited<ReturnType<typeof isolatedRunner>> | undefined,
        stage: WorkspaceStage | undefined,
        workspace: RunnerWorkspace | undefined,
        home: string | undefined,
        empty: string | undefined;
      try {
        if (server.transport === "stdio") {
          if (
            server.executableHash &&
            (await executableHash(server.command)) !== server.executableHash
          )
            throw new RuntimeError("MCP executable changed. Test it and grant access again.", 409);
          if (options.workspace) {
            workspace = await this.workspace(server);
            stage = await workspace.stage(this.redact);
          } else empty = await mkdtemp("/dev/shm/vektor-mcp-stage-");
          home = await mkdtemp("/dev/shm/vektor-mcp-home-");
          isolated = await isolatedRunner({
            command: server.command,
            args: server.args,
            hosts: server.networkHosts,
            credentials: { ...server.environment, ...this.store.credentials(server.id) },
            signal: combined,
            home,
            stage: stage?.directory ?? empty,
            stageReadOnly: options.readOnly,
          });
          client = new McpClient(
            new PinnedTransport(new IsolatedStdioTransport({ ...isolated })),
            combined,
          );
        } else
          client = new McpClient(
            remoteTransport(
              server,
              this.store.credentials(server.id),
              combined,
              this.protectedPort,
            ),
            combined,
          );
        combined.throwIfAborted();
        await client.connect();
        const discovery = await client.discover();
        if (server.discovery && discovery.hash !== server.discovery.hash)
          throw new RuntimeError(
            "MCP definitions or version changed. Test and grant access again.",
            409,
          );
        if (this.redact(JSON.stringify(discovery)) !== JSON.stringify(discovery))
          throw new RuntimeError(
            "MCP discovery exposed protected credentials and was rejected.",
            403,
          );
        combined.throwIfAborted();
        if (this.store.get(server.id).revision !== server.revision)
          throw new RuntimeError("MCP configuration changed.", 409);
        const result = await work(client, stage, workspace);
        combined.throwIfAborted();
        this.store.healthy(server.id);
        return result;
      } finally {
        try {
          await client?.close();
        } finally {
          controller.abort();
          await isolated?.close();
          if (home) await rm(home, { recursive: true, force: true });
          if (stage) await rm(stage.directory, { recursive: true, force: true });
          if (empty) await rm(empty, { recursive: true, force: true });
        }
      }
    })();
    this.running.set(id, { serverId: server.id, ...scope, controller, done });
    void done.finally(() => this.running.delete(id)).catch(() => {});
    return done;
  }
  async test(id: string): Promise<McpServer> {
    const server = this.store.get(id);
    // Explicit reconnect tests the current definition, rather than retrying work.
    this.store.resetHealth(id);
    try {
      const initialHash =
        server.transport === "stdio" ? await executableHash(server.command) : undefined;
      return await this.operation(
        { ...server, discovery: null, executableHash: initialHash },
        new AbortController().signal,
        {},
        async (client) => {
          const discovery = await client.discover();
          const binaryHash =
            server.transport === "stdio" ? await executableHash(server.command) : undefined;
          if (binaryHash !== initialHash)
            throw new RuntimeError(
              "MCP executable changed during testing. Test the stable executable again.",
              409,
            );
          return this.store.tested(id, discovery, binaryHash);
        },
        { workspace: false, readOnly: true },
      );
    } catch (error) {
      this.store.failed(id);
      throw error instanceof RuntimeError
        ? error
        : new RuntimeError(
            "MCP test failed. Check the endpoint, installed executable, supported protocol and separate credentials.",
            409,
          );
    }
  }
  async invoke(
    name: string,
    input: unknown,
    context: McpInvocation,
  ): Promise<{ output: string; isError: boolean }> {
    const { server, tool, readOnly } = this.find(name, context),
      started = Date.now(),
      policy = this.store.policyHash(context.profileId);
    const raw = JSON.stringify(input);
    if (Buffer.byteLength(raw) > 32 * 1024 || this.redact(raw) !== raw)
      throw new RuntimeError(
        "MCP arguments exceed their limit or contain protected credentials.",
        403,
      );
    await validateSchemas([tool.inputSchema], input);
    // Approval precedes connection/startup and applies even to read-only hints.
    if (
      !(await context.approve({
        kind: "mcp.tool",
        server: server.name,
        serverId: server.id,
        tool: tool.name,
        policy: readOnly ? "read-only" : "approval",
        arguments: input,
      }))
    )
      throw new RuntimeError("MCP tool call denied or cancelled.", 403);
    this.find(name, context);
    if (policy !== this.store.policyHash(context.profileId))
      throw new RuntimeError("MCP permissions changed while approval was pending.", 403);
    try {
      return await this.operation(
        server,
        context.signal,
        context,
        async (client, stage, workspace) => {
          const result = await client.call(tool, input, context.signal, (detail) =>
            context.progress({
              ...(typeof detail === "object" ? detail : {}),
              serverId: server.id,
              tool: tool.name,
            }),
          );
          await client.close();
          const text = this.redact(JSON.stringify(result));
          if (Buffer.byteLength(text) > 128 * 1024)
            throw new RuntimeError("MCP result exceeds 128 KiB.", 413);
          this.find(name, context);
          if (stage && workspace && !readOnly) {
            const proposals = await workspace.stageChanges(stage);
            if (proposals.length > 16)
              throw new RuntimeError("MCP tool proposed more than sixteen file changes.", 409);
            for (const proposal of proposals) {
              if (
                proposal.content !== undefined &&
                this.redact(proposal.content) !== proposal.content
              )
                throw new RuntimeError(
                  "MCP file proposals cannot contain protected credentials.",
                  403,
                );
              const before = proposal.previousHash
                ? await workspace.read({ path: proposal.path })
                : undefined;
              const approve = async () => {
                const allowed = await context.approve({
                  kind: "mcp.file",
                  server: server.name,
                  directory: server.workingDirectory,
                  ...proposal,
                  before,
                });
                this.find(name, context);
                return allowed && !context.signal.aborted;
              };
              if (proposal.content !== undefined)
                await workspace.write(
                  { path: proposal.path, content: proposal.content },
                  approve,
                  context.signal,
                  proposal.previousHash,
                );
              else if (proposal.previousHash)
                await workspace.remove(
                  proposal.path,
                  proposal.previousHash,
                  approve,
                  context.signal,
                );
              appendAudit(this.db, "mcp.file_applied", context.runId, {
                serverId: server.id,
                path: proposal.path,
                directory: server.workingDirectory,
                deletion: proposal.content === undefined,
              });
            }
          }
          let output = text;
          if (text.length > 12000) {
            const artifactId = await this.content.artifact(context.runId, text);
            output = JSON.stringify({
              untrustedMcpResult: text.slice(0, 8000),
              truncated: true,
              artifactId,
            });
          }
          appendAudit(this.db, "mcp.tool_finished", context.runId, {
            serverId: server.id,
            tool: tool.name,
            durationMs: Date.now() - started,
            isError: result.isError ?? false,
          });
          return { output, isError: result.isError ?? false };
        },
        { workspace: true, readOnly },
      );
    } catch (error) {
      if (!context.signal.aborted && (!(error instanceof RuntimeError) || error.statusCode !== 403))
        this.store.failed(server.id);
      appendAudit(this.db, "mcp.tool_failed", context.runId, {
        serverId: server.id,
        tool: tool.name,
        durationMs: Date.now() - started,
      });
      throw error instanceof RuntimeError
        ? error
        : new RuntimeError(
            "MCP tool failed or disconnected. No work was replayed; other native tools remain available.",
            409,
          );
    }
  }
  async preview(
    profileId: string,
    id: string,
    kind: "resource" | "template" | "prompt",
    name: string,
    args: Record<string, string>,
    uri?: string,
  ): Promise<McpContext> {
    this.profile(profileId);
    const server = this.store.get(id),
      grant = this.store.grant(profileId, id);
    const expectedPolicy = this.store.policyHash(profileId);
    if (
      !server.enabled ||
      !(
        kind === "prompt" ? grant.prompts : kind === "template" ? grant.templates : grant.resources
      ).includes(name)
    )
      throw new RuntimeError("This MCP context source is not granted.", 403);
    if (this.redact(JSON.stringify({ args, uri })) !== JSON.stringify({ args, uri }))
      throw new RuntimeError("MCP context arguments cannot contain protected credentials.", 403);
    let target = name;
    if (Buffer.byteLength(JSON.stringify(args)) > 32 * 1024)
      throw new RuntimeError("MCP context arguments exceed 32 KiB.", 413);
    if (kind === "resource" && Object.keys(args).length)
      throw new RuntimeError("A concrete MCP resource takes no arguments.", 400);
    if (kind === "prompt") {
      const prompt = server.discovery?.prompts.find((p) => p.name === name);
      if (
        !prompt ||
        Object.keys(args).some((n) => !prompt.arguments?.some((a) => a.name === n)) ||
        prompt.arguments?.some((a) => a.required && args[a.name] === undefined)
      )
        throw new RuntimeError(
          "Provide only the declared MCP prompt arguments, including required values.",
          400,
        );
    }
    if (kind === "template") {
      const template = new UriTemplate(name);
      if (
        template.variableNames.some((n) => args[n] === undefined) ||
        Object.keys(args).some((n) => !template.variableNames.includes(n))
      )
        throw new RuntimeError("Provide the declared MCP template variables.", 400);
      target = template.expand(args);
      if (target.length > 2000)
        throw new RuntimeError("Expanded MCP resource URI exceeds its limit.", 413);
    }
    const signal = AbortSignal.timeout(15_000);
    return this.operation(
      server,
      signal,
      { profileId },
      async (client) => {
        const text = this.redact(
          kind === "prompt" ? await client.prompt(name, args) : await client.resource(target),
        );
        const current = this.store.get(id);
        if (
          !current.enabled ||
          current.revision !== server.revision ||
          this.store.policyHash(profileId) !== expectedPolicy
        )
          throw new RuntimeError("MCP context permissions changed.", 403);
        const result = await this.content.saveContext(
          { profileId, serverId: id, revision: server.revision, kind, name },
          text,
        );
        appendAudit(this.db, "mcp.context_prepared", null, {
          profileId,
          serverId: id,
          contextId: result.id,
          kind,
          name,
        });
        return result;
      },
      { workspace: true, readOnly: true },
    );
  }
  contexts(profileId: string): McpContext[] {
    this.profile(profileId);
    return this.content
      .list()
      .filter(
        (c) =>
          c.profileId === profileId &&
          this.store
            .list()
            .some(
              (s) =>
                s.id === c.serverId &&
                s.enabled &&
                s.revision === c.revision &&
                (c.kind === "prompt"
                  ? this.store.grant(profileId, s.id).prompts
                  : c.kind === "template"
                    ? this.store.grant(profileId, s.id).templates
                    : this.store.grant(profileId, s.id).resources
                ).includes(c.name),
            ),
      );
  }
  async selectedContext(profileId: string, ids: string[]): Promise<string> {
    this.profile(profileId);
    const policy = this.store.policyHash(profileId);
    if (new Set(ids).size !== ids.length || ids.length > 5)
      throw new RuntimeError("Select at most five distinct MCP context items.", 400);
    const available = this.contexts(profileId),
      parts: string[] = [];
    for (const id of ids) {
      const item = available.find((c) => c.id === id);
      if (!item)
        throw new RuntimeError("Selected MCP context is unavailable for this profile.", 403);
      const grant = this.store.grant(profileId, item.serverId);
      if (
        !(
          item.kind === "prompt"
            ? grant.prompts
            : item.kind === "template"
              ? grant.templates
              : grant.resources
        ).includes(item.name)
      )
        throw new RuntimeError("MCP context grant was revoked.", 403);
      parts.push(
        `\n\n<untrusted_mcp_context id=${JSON.stringify(id)} source=${JSON.stringify(item.name)}>\n${this.redact(await this.content.read("contexts", id))}\n</untrusted_mcp_context>`,
      );
    }
    const text = parts.join("");
    if (policy !== this.store.policyHash(profileId))
      throw new RuntimeError("MCP context permissions changed while reading it.", 409);
    if (Buffer.byteLength(text) > 100 * 1024)
      throw new RuntimeError("Selected MCP context exceeds 100 KiB.", 413);
    return text;
  }
  async stop(
    filter: { serverId?: string; profileId?: string; runId?: string } = {},
  ): Promise<void> {
    const sessions = [...this.running.values()].filter(
      (s) =>
        (!filter.serverId || s.serverId === filter.serverId) &&
        (!filter.profileId || s.profileId === filter.profileId) &&
        (!filter.runId || s.runId === filter.runId),
    );
    for (const session of sessions) session.controller.abort();
    await Promise.allSettled(sessions.map((s) => s.done));
  }
}
