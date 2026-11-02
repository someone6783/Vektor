import { conversationProfile } from "../conversation-execution.js";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import {
  getRun,
  getSetting,
  updateRun,
  getProfile,
  appendAudit,
  type ProfileRecord,
  type RunRecord,
  type VektorDatabase,
} from "@vektor/db";
import {
  RUNNER_CONTRACT_VERSION,
  harnessStateSchema,
  runnerIdSchema,
  type HarnessState,
  type RunUsage,
} from "@vektor/shared";
import { RuntimeError } from "../runtime/terminal.js";
import type { ChatMessage } from "../providers/types.js";
import type { RunnerInstallations, Installation } from "./installations.js";
import { isolatedRunner } from "./isolation.js";
import { HarnessSnapshots } from "./snapshots.js";
import { CodexSession, AcpSession, type HarnessEvent } from "./protocol.js";
import { RunnerWorkspace } from "./workspace.js";
import { assertRunnerAvailable } from "./registry.js";
import { runtimeSystemPrompt } from "../runtime/policy.js";

export interface HarnessExecution {
  mcpTools?: NonNullable<ChatRequest["tools"]>;
  mcpPolicyHash?: string;
  run: RunRecord;
  profile: ProfileRecord;
  messages: ChatMessage[];
  signal: AbortSignal;
  resumeFromRunId?: string;
  event: (event: HarnessEvent) => void;
  invoke: (name: string, input: unknown, id: string, signal?: AbortSignal) => Promise<string>;
  redact: (value: string) => string;
  permission: (kind: "command" | "file", detail: unknown, signal: AbortSignal) => Promise<boolean>;
}
export class ExternalRunners {
  private readonly running = new Map<
    string,
    { controller: AbortController; done: Promise<void> }
  >();
  readonly workspace: RunnerWorkspace;
  readonly snapshots: HarnessSnapshots;
  constructor(
    readonly db: VektorDatabase,
    readonly installations: RunnerInstallations,
    dataDir: string,
    key: Buffer,
    private readonly isolate: typeof isolatedRunner = isolatedRunner,
  ) {
    this.workspace = new RunnerWorkspace(join(dataDir, "workspace"));
    this.snapshots = new HarnessSnapshots(dataDir, key);
  }
  assertReady(identity: unknown, profile: ProfileRecord): Installation | undefined {
    const parsed = runnerIdSchema.safeParse(identity);
    if (!parsed.success) throw new RuntimeError("Unsupported runner identity.", 409);
    if (parsed.data === "native") return;
    if (parsed.data === "cli") {
      assertRunnerAvailable(identity);
      return;
    }
    const entry = this.installations.get(parsed.data);
    if (!entry?.enabled)
      throw new RuntimeError(
        "The selected runner is unavailable or disabled. Verify and enable it in Settings.",
        409,
      );
    if (profile.terminalMode !== "full-access" || !profile.tools.includes("terminal"))
      throw new RuntimeError(
        "External runners currently require Full access with the terminal tool enabled. No-terminal, Basic and Full Unrestricted mappings are unsupported.",
        409,
      );
    if (
      (profile.browser?.mode && profile.browser.mode !== "off") ||
      (profile.computer?.mode && profile.computer.mode !== "off")
    )
      throw new RuntimeError(
        "Browser and computer capabilities are not supported by this runner adapter. Disable them or explicitly choose Native.",
        409,
      );
    const grant = this.installations.grant(profile.id);
    if (grant.runner !== entry.id || !grant.workspace || !grant.inference)
      throw new RuntimeError(
        "Grant this profile workspace and inference access to this specific agent before running it.",
        409,
      );
    if (!this.installations.credential(entry.id))
      throw new RuntimeError(
        "Configure this agent's separate authentication in Settings. OpenRouter credentials are not used.",
        409,
      );
    const health = this.installations.health(entry.id);
    if (health.retryAt > Date.now())
      throw new RuntimeError(
        `The agent's last connection failed (${health.state}). Reconnect explicitly after ${new Date(health.retryAt).toISOString()}; no prompt was replayed.`,
        409,
      );
    if (entry.interface === "acp-v1") {
      const record = this.installations.catalog
        .snapshot()
        ?.agents.find((agent) => `acp:${agent.id}` === entry.id);
      const hash = record ? createHash("sha256").update(JSON.stringify(record)).digest("hex") : "";
      if (!record || record.version !== entry.version || hash !== entry.sourceHash)
        throw new RuntimeError(
          "Registry metadata changed; explicitly re-verify this agent before running it.",
          409,
        );
    }
    return entry;
  }
  validateResume(
    run: Pick<RunRecord, "runner" | "channelId" | "profileId">,
    previousId?: string,
  ): HarnessState | undefined {
    if (!previousId) return;
    const previous = getRun(this.db, previousId);
    if (
      !previous ||
      previous.runner !== run.runner ||
      previous.channelId !== run.channelId ||
      previous.profileId !== run.profileId ||
      previous.status !== "completed"
    )
      throw new RuntimeError(
        "Resume requires a completed run in the same conversation, profile and runner.",
        409,
      );
    const state = harnessStateSchema.safeParse(previous.harness);
    if (!state.success || !state.data.sessionId)
      throw new RuntimeError("This run has no resumable agent session.", 409);
    return state.data;
  }
  async execute(input: HarnessExecution): Promise<void> {
    if (this.running.size >= 4)
      throw new RuntimeError("The external runner concurrency limit is reached.", 409);
    if (this.running.has(input.run.id))
      throw new RuntimeError("This run already owns a runner session.", 409);
    const controller = new AbortController();
    const signal = AbortSignal.any([input.signal, controller.signal]);
    const done = this.perform({ ...input, signal }, () => controller.abort());
    this.running.set(input.run.id, { controller, done });
    try {
      await done;
      this.installations.succeeded(input.run.runner);
    } catch (error) {
      if (!input.signal.aborted) this.installations.failed(input.run.runner, error);
      throw error;
    } finally {
      this.running.delete(input.run.id);
    }
  }
  async stop(id?: string): Promise<void> {
    const runs = [...this.running.entries()].filter(([runId]) => !id || id === runId);
    for (const [, run] of runs) run.controller.abort();
    await Promise.allSettled(runs.map(([, run]) => run.done));
  }
  async revokeProfile(profileId: string): Promise<void> {
    await Promise.all(
      [...this.running.keys()]
        .filter((id) => getRun(this.db, id)?.profileId === profileId)
        .map((id) => this.stop(id)),
    );
  }
  async revokeRunner(identity: string): Promise<void> {
    await Promise.all(
      [...this.running.keys()]
        .filter((id) => getRun(this.db, id)?.runner === identity)
        .map((id) => this.stop(id)),
    );
  }
  private async perform(input: HarnessExecution, cancel: () => void): Promise<void> {
    const entry = this.assertReady(input.run.runner, input.profile);
    if (!entry) throw new RuntimeError("An external runner was not selected.");
    await this.installations.verifyExecutable(entry);
    const previous = this.validateResume(input.run, input.resumeFromRunId);
    const context = z
      .object({
        selectedAttachmentIds: z.array(z.string()).optional(),
        selectedMcpContextIds: z.array(z.string()).optional(),
        droppedMessages: z.number().optional(),
      })
      .passthrough()
      .parse(input.run.context ?? {});
    const contextSelection = {
      attachmentIds: [...(context.selectedAttachmentIds ?? [])].sort(),
      mcpContextIds: [...(context.selectedMcpContextIds ?? [])].sort(),
      includeHistory: input.run.includeHistory,
      truncated: (context.droppedMessages ?? 0) > 0,
    };
    if (
      previous &&
      (!previous.contextSelection ||
        contextSelection.truncated ||
        !contextSelection.includeHistory ||
        previous.contextSelection.truncated ||
        !previous.contextSelection.includeHistory ||
        JSON.stringify(contextSelection.attachmentIds) !==
          JSON.stringify(previous.contextSelection.attachmentIds) ||
        JSON.stringify(contextSelection.mcpContextIds) !==
          JSON.stringify(previous.contextSelection.mcpContextIds ?? []))
    )
      throw new RuntimeError(
        "Selected attachments, MCP context or history scope changed. Start a fresh agent session so excluded context is not restored.",
        409,
      );
    const policyHash = createHash("sha256")
      .update(
        JSON.stringify({
          interface: entry.interface,
          promptHash: createHash("sha256").update(input.profile.systemPrompt).digest("hex"),
          args: entry.args,
          hosts: entry.inferenceHosts,
          grant: this.installations.grant(input.profile.id),
          authenticationVersion: getSetting(this.db, `runner.authVersion.${entry.id}`) ?? 0,
          mcpPolicyHash: input.mcpPolicyHash,
        }),
      )
      .digest("hex");
    if (previous && previous.policyHash !== policyHash)
      throw new RuntimeError(
        "Runner grants, authentication or configuration changed. Start a fresh session instead of resuming.",
        409,
      );
    if (
      previous &&
      (previous.executableHash !== entry.executableHash || previous.agentVersion !== entry.version)
    )
      throw new RuntimeError(
        "The agent version changed; start a fresh session instead of resuming.",
        409,
      );
    input.signal.throwIfAborted();
    const stage = await this.workspace.stage(input.redact);
    let home: string;
    try {
      home = await this.snapshots.home(input.resumeFromRunId);
    } catch (error) {
      await rm(stage.directory, { recursive: true, force: true });
      throw error;
    }
    let isolated: Awaited<ReturnType<typeof isolatedRunner>> | undefined;
    let mcpBroker: McpBroker | undefined;
    let mcpPromptActive = false;
    let session: CodexSession | AcpSession | undefined;
    let completed = false;
    let checkpointed = false;
    let state: HarnessState = {
      contractVersion: RUNNER_CONTRACT_VERSION,
      interface: entry.interface,
      executableHash: entry.executableHash,
      policyHash,
      agentVersion: entry.version,
      cursor: 0,
      state: "starting",
      metricsAvailable: false,
      contextSelection,
      ...(input.resumeFromRunId ? { resumeFromRunId: input.resumeFromRunId } : {}),
    };
    updateRun(this.db, input.run.id, { harness: state });
    const terminal = new Map<
      string,
      { controller: AbortController; done: Promise<string>; output?: string; released: boolean }
    >();
    const check = () => {
      input.signal.throwIfAborted();
      const latest = getProfile(this.db, input.profile.id);
      if (!latest || latest.archivedAt !== null)
        throw new RuntimeError("Profile is unavailable.", 403);
      this.assertReady(input.run.runner, conversationProfile(this.db, input.run.channelId, latest));
    };
    const event = (event: HarnessEvent) => {
      if (input.signal.aborted) return;
      const reported = event.type === "usage" ? harnessUsage(event.detail) : null;
      state = {
        ...state,
        cursor: state.cursor + 1,
        state: "running",
        ...(event.type === "lifecycle" ? { sessionId: event.sessionId, turnId: event.turnId } : {}),
        ...(reported ? { metricsAvailable: true, reportedUsage: reported } : {}),
      };
      updateRun(this.db, input.run.id, { harness: state });
      if (event.type === "usage") {
        if (!reported) return;
        const baseline = previous?.reportedUsage;
        const delta = {
          inputTokens: reported.promptTokens - (baseline?.promptTokens ?? 0),
          outputTokens: reported.completionTokens - (baseline?.completionTokens ?? 0),
          totalTokens: reported.totalTokens - (baseline?.totalTokens ?? 0),
        };
        if (Object.values(delta).some((value) => value < 0)) {
          state.metricsAvailable = false;
          updateRun(this.db, input.run.id, { harness: state });
          return;
        }
        input.event({ type: "usage", detail: { tokenUsage: { total: delta } } });
      } else input.event(event);
    };
    let toolCount = 0;
    const invoke = async (
      name: string,
      args: unknown,
      id: string = randomUUID(),
      localSignal?: AbortSignal,
    ) => {
      check();
      if (++toolCount > 32) throw new RuntimeError("External runner tool budget exceeded.", 409);
      const result = await input.invoke(
        name,
        args,
        id,
        localSignal ? AbortSignal.any([input.signal, localSignal]) : input.signal,
      );
      if (name === "workspace_write" && result === "File change applied.") {
        const path = z.object({ path: z.string() }).parse(args).path;
        await this.workspace.syncStage(stage, path, input.redact);
      }
      return result;
    };
    try {
      let brokerSocket: string | undefined;
      if (entry.interface === "acp-v1" && input.mcpTools?.length) {
        mcpBroker = new McpBroker(
          input.mcpTools,
          async (name, args, id, signal) => {
            if (!mcpPromptActive)
              throw new RuntimeError(
                "MCP calls require an active ACP prompt; saved calls are never replayed during load.",
                403,
              );
            return invoke(name, args, id, signal);
          },
          input.signal,
        );
        brokerSocket = await mcpBroker.listen();
      }
      isolated = await this.isolate({
        command: entry.command,
        args: entry.args,
        hosts: entry.inferenceHosts,
        credentials: { [entry.credentialName]: this.installations.credential(entry.id)! },
        signal: input.signal,
        home,
        stage: stage.directory,
        brokerSocket,
      });
      isolated.orphanCleanupPaths.push(...(mcpBroker?.cleanupPaths ?? []));
      const options = {
        ...isolated,
        failure: cancel,
        signal: input.signal,
        event,
        permission: (kind: "command" | "file", detail: unknown) =>
          input.permission(kind, detail, input.signal),
      };
      if (entry.interface === "codex-app-server") {
        const codex = new CodexSession({
          ...options,
          verifyControls: true,
          tool: async (tool, args) => {
            if (input.mcpTools?.some((t) => t.function.name === tool)) return invoke(tool, args);
            const name = {
              vektor_terminal: "terminal",
              vektor_read_file: "workspace_read",
              vektor_write_file: "workspace_write",
            }[tool];
            if (!name) throw new RuntimeError("The Codex tool is not granted.", 403);
            return invoke(name, args);
          },
        });
        session = codex;
        const version = await codex.initialize();
        if (!version.includes(entry.version))
          throw new RuntimeError("Codex version drift detected.", 409);
        await codex.verifyControls();
        if (previous) await codex.resume(previous.sessionId!);
        else
          await codex.create({
            model: input.run.model,
            cwd: "/workspace",
            approvalPolicy: "untrusted",
            sandbox: "read-only",
            baseInstructions: `${runtimeSystemPrompt(input.profile)}\n\nYour local filesystem is isolated scratch. Only vektor_* tools access the explicitly granted real Vektor workspace. Use those tools for real changes; never claim that a local scratch edit changed the user workspace.`,
            dynamicTools: [
              ...brokerTools,
              ...(input.mcpTools ?? []).map((t) => ({
                name: t.function.name,
                description: t.function.description,
                inputSchema: t.function.parameters,
              })),
            ],
          });
        check();
        await codex.prompt(contextText(input.messages, !!previous), input.run.model);
      } else {
        const acp = new AcpSession({
          ...options,
          clientRequest: async (method, params) => {
            check();
            if (method === "fs/read_text_file") {
              const parsed = z
                .object({
                  path: z.string(),
                  line: z.number().optional(),
                  limit: z.number().optional(),
                })
                .parse(params);
              return { content: await invoke("workspace_read", parsed) };
            }
            if (method === "fs/write_text_file") {
              const parsed = z.object({ path: z.string(), content: z.string() }).parse(params);
              await invoke("workspace_write", parsed);
              return {};
            }
            if (method === "terminal/create") {
              const parsed = z
                .object({
                  command: z.string(),
                  args: z.array(z.string()).default([]),
                  cwd: z.string().optional(),
                  env: z.array(z.unknown()).optional(),
                })
                .parse(params);
              if (parsed.env?.length || terminal.size >= 8)
                throw new RuntimeError(
                  "Terminal environment changes and additional terminals are unsupported.",
                  403,
                );
              const id = randomUUID();
              const controller = new AbortController();
              const record = {
                controller,
                done: Promise.resolve(""),
                output: undefined as string | undefined,
                released: false,
              };
              record.done = invoke(
                "terminal",
                {
                  command: parsed.command,
                  args: parsed.args,
                  ...(parsed.cwd
                    ? {
                        cwd:
                          parsed.cwd === "/workspace"
                            ? "."
                            : parsed.cwd.startsWith("/workspace/")
                              ? parsed.cwd.slice(11)
                              : parsed.cwd,
                      }
                    : {}),
                },
                id,
                controller.signal,
              ).then((output) => {
                record.output = output;
                return output;
              });
              void record.done.catch(() => {});
              terminal.set(id, record);
              return { terminalId: id };
            }
            if (method.startsWith("terminal/")) {
              const id = z.string().parse(params.terminalId);
              const record = terminal.get(id);
              if (!record || record.released) throw new RuntimeError("Unknown terminal.", 403);
              if (method === "terminal/kill" || method === "terminal/release") {
                record.controller.abort();
                if (method.endsWith("release")) record.released = true;
                return {};
              }
              if (method === "terminal/wait_for_exit") {
                await record.done;
                return exitStatus(record.output);
              }
              if (method === "terminal/output")
                return {
                  output: record.output ?? "",
                  truncated: false,
                  ...(record.output !== undefined ? { exitStatus: exitStatus(record.output) } : {}),
                };
            }
            throw new RuntimeError("Unsupported ACP client request.", 403);
          },
        });
        session = acp;
        const agent = await acp.initialize();
        if (agent.version !== entry.version)
          throw new RuntimeError("ACP version drift detected.", 409);
        if (previous)
          await acp.resume(previous.sessionId!, "/workspace", mcpBroker ? [brokerMcpServer] : []);
        else await acp.create("/workspace", mcpBroker ? [brokerMcpServer] : []);
        const actualModel = await acp.selectModel(input.run.model);
        updateRun(this.db, input.run.id, { model: actualModel });
        check();
        mcpPromptActive = true;
        try {
          await acp.prompt(
            `${runtimeSystemPrompt(input.profile)}\n\n${contextText(input.messages, !!previous)}`,
          );
        } finally {
          mcpPromptActive = false;
        }
      }
      if ([...terminal.values()].some((record) => record.output === undefined && !record.released))
        throw new RuntimeError("Agent completed while a terminal or approval was still pending.");
      await session.close(true);
      session = undefined;
      const proposals = await this.workspace.stageChanges(stage);
      if (proposals.length > 32)
        throw new RuntimeError(
          "Agent proposed more than 32 workspace changes. Review a smaller task.",
          409,
        );
      for (const proposal of proposals) {
        check();
        const before = proposal.previousHash
          ? await this.workspace.read({ path: proposal.path })
          : undefined;
        const result = await invoke("workspace_proposal", {
          ...proposal,
          ...(before !== undefined ? { before } : {}),
        });
        event({
          type: "text",
          text: `\n\nWorkspace change ${JSON.stringify(proposal.path)}: ${result}\n`,
        });
      }
      completed = true;
    } catch (error) {
      cancel();
      throw error;
    } finally {
      for (const record of terminal.values()) record.controller.abort();
      await session?.close();
      await mcpBroker?.close();
      await Promise.allSettled([...terminal.values()].map((record) => record.done));
      await isolated?.close();
      try {
        if (completed && !input.signal.aborted) {
          await this.snapshots.save(input.run.id, home);
          checkpointed = true;
        }
      } finally {
        await rm(home, { recursive: true, force: true });
        await rm(stage.directory, { recursive: true, force: true });
        const run = getRun(this.db, input.run.id);
        updateRun(this.db, input.run.id, {
          harness: {
            ...state,
            state:
              completed && checkpointed && !input.signal.aborted
                ? "completed"
                : run?.status === "cancelled"
                  ? "cancelled"
                  : "failed",
          },
        });
      }
      appendAudit(this.db, "runner.session_closed", input.run.id, {
        runner: entry.id,
        interface: entry.interface,
        sessionId: state.sessionId,
        turnId: state.turnId,
        cursor: state.cursor,
        completed,
      });
    }
  }
}
function exitStatus(output?: string): { exitCode: number | null } {
  try {
    return {
      exitCode: z.object({ exitCode: z.number().nullable() }).parse(JSON.parse(output ?? "{}"))
        .exitCode,
    };
  } catch {
    return { exitCode: null };
  }
}
function contextText(messages: ChatMessage[], resumed: boolean): string {
  const selected = resumed
    ? messages.filter((message) => message.role === "user").slice(-1)
    : messages;
  return selected
    .map((message) => {
      if (typeof message.content !== "string")
        throw new RuntimeError(
          "External runners currently accept text context only. Exclude images before running.",
          409,
        );
      return `[${message.role}]\n${message.content}`;
    })
    .join("\n\n");
}
export function harnessUsage(detail: unknown): RunUsage | null {
  const parsed = z
    .object({
      tokenUsage: z.object({
        total: z.object({
          inputTokens: z.number().int().nonnegative(),
          outputTokens: z.number().int().nonnegative(),
          totalTokens: z.number().int().nonnegative(),
        }),
      }),
    })
    .safeParse(detail);
  if (!parsed.success) return null;
  const total = parsed.data.tokenUsage.total;
  return {
    promptTokens: total.inputTokens,
    completionTokens: total.outputTokens,
    totalTokens: total.totalTokens,
  };
}
const brokerTools = [
  {
    name: "vektor_terminal",
    description:
      "Run a command in the real Vektor workspace with human approval. Use this instead of local shell tools; /workspace inside the agent is isolated scratch.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        args: { type: "array", items: { type: "string" } },
        cwd: { type: "string" },
      },
      required: ["command", "args"],
      additionalProperties: false,
    },
  },
  {
    name: "vektor_read_file",
    description:
      "Read a text file in the explicitly granted real workspace. Paths are relative or /workspace/... . Agent-local files are isolated scratch.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "vektor_write_file",
    description:
      "Propose a real workspace text file change for human approval. Paths are relative or /workspace/... .",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
];
import { McpBroker, brokerMcpServer } from "../mcp/broker.js";
import type { ChatRequest } from "../providers/types.js";
