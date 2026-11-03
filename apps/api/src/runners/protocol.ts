import { reasoningEffortSchema, type ModelInfo, type RunnerContext } from "@vektor/shared";
import { z } from "zod";
import { harnessError, StdioRpc, type RpcMessage, type RpcOptions } from "./rpc.js";

const id = z.string().min(1).max(300);
const object = z.record(z.unknown());
export type HarnessEvent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "lifecycle"; sessionId: string; turnId: string | null }
  | { type: "tool"; id: string; status: "started" | "completed"; detail: unknown }
  | { type: "usage"; detail: unknown }
  | { type: "context"; context: RunnerContext }
  | { type: "diff"; detail: unknown };
export interface SessionOptions extends Omit<RpcOptions, "notification" | "request"> {
  event: (event: HarnessEvent) => void;
  verifyControls?: boolean;
  tool?: (name: string, input: unknown) => Promise<string>;
  clientRequest?: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  // Hooks never grant capabilities from agent-supplied labels or metadata.
  permission?: (kind: "command" | "file", detail: unknown) => Promise<boolean>;
}

export class CodexSession {
  private readonly rpc: StdioRpc;
  private sessionId?: string;
  private turnId?: string;
  private prompting = false;
  private finished?: { resolve: () => void; reject: (error: Error) => void };
  private readonly completedItems = new Set<string>();
  private readonly startedItems = new Set<string>();
  private error?: Error;
  constructor(private readonly options: SessionOptions) {
    this.rpc = new StdioRpc({
      ...options,
      interrupt: async () => {
        if (this.sessionId && this.turnId)
          await this.rpc.call("turn/interrupt", { threadId: this.sessionId, turnId: this.turnId });
      },
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(120_000)])
        : AbortSignal.timeout(120_000),
      notification: (message) => this.notification(message),
      request: async (message) => {
        const params = object.parse(message.params);
        if (params.threadId !== this.sessionId || params.turnId !== this.turnId || !this.prompting)
          throw new Error("Foreign approval request");
        if (message.method === "item/tool/call") {
          const request = z.object({ tool: z.string(), arguments: z.unknown() }).parse(params);
          if (!options.tool) throw new Error("No external tools granted");
          const text = await options.tool(request.tool, request.arguments);
          return { contentItems: [{ type: "inputText", text }], success: true };
        }
        const kind =
          message.method === "item/commandExecution/requestApproval"
            ? "command"
            : message.method === "item/fileChange/requestApproval"
              ? "file"
              : null;
        if (!kind) throw new Error("Unsupported permission kind");
        const approved = (await options.permission?.(kind, params)) ?? false;
        // No session-wide approval and no execution-policy amendments.
        return {
          decision: approved && this.prompting && !options.signal?.aborted ? "accept" : "decline",
        };
      },
    });
    void this.rpc.exited.then(() =>
      this.fail(new Error("Codex disconnected; the prompt will not be replayed.")),
    );
  }
  async initialize(): Promise<string> {
    const result = z.object({ userAgent: z.string().min(1).max(1000) }).parse(
      await this.rpc.call("initialize", {
        clientInfo: { name: "vektor", version: "0.1.0", title: "Vektor" },
        capabilities: { experimentalApi: true },
      }),
    );
    this.rpc.notify("initialized", {});
    return result.userAgent;
  }
  async verifyControls(): Promise<void> {
    const result = z
      .object({ config: z.record(z.unknown()) })
      .parse(await this.rpc.call("config/read", { includeLayers: false }));
    const features = z.record(z.unknown()).parse(result.config.features);
    for (const feature of [
      "shell_tool",
      "unified_exec",
      "apps",
      "plugins",
      "browser_use",
      "computer_use",
    ])
      if (features[feature] !== false)
        throw new Error(`Codex did not enforce the disabled ${feature} capability.`);
    if (Object.keys(z.record(z.unknown()).parse(result.config.mcp_servers ?? {})).length)
      throw new Error("Codex inherited MCP servers; execution is blocked.");
  }
  private checkThreadControls(raw: unknown): void {
    z.object({
      approvalPolicy: z.literal("untrusted"),
      cwd: z.literal("/workspace"),
      sandbox: z.object({ type: z.literal("readOnly") }),
      instructionSources: z.array(z.unknown()).max(0),
    }).parse(raw);
  }
  async models(): Promise<{ models: ModelInfo[]; defaultModel: string }> {
    const models: Array<ModelInfo & { isDefault: boolean }> = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const result = z
        .object({
          data: z
            .array(
              z.object({
                id: z.string(),
                model: z.string(),
                displayName: z.string(),
                hidden: z.boolean().optional(),
                isDefault: z.boolean(),
                inputModalities: z.array(z.string()).optional(),
                supportedReasoningEfforts: z
                  .array(z.object({ reasoningEffort: z.string() }))
                  .default([]),
              }),
            )
            .max(200),
          nextCursor: z.string().nullable().optional(),
        })
        .parse(
          await this.rpc.call("model/list", {
            limit: 100,
            includeHidden: false,
            ...(cursor ? { cursor } : {}),
          }),
        );
      for (const item of result.data) {
        if (item.hidden || seen.has(item.model)) continue;
        seen.add(item.model);
        models.push({
          id: item.model,
          name: item.displayName,
          isDefault: item.isDefault,
          supportsImages: !item.inputModalities || item.inputModalities.includes("image"),
          reasoningEfforts: item.supportedReasoningEfforts.flatMap((entry) => {
            const effort = reasoningEffortSchema.safeParse(entry.reasoningEffort);
            return effort.success ? [effort.data] : [];
          }),
        });
      }
      if (!result.nextCursor) {
        if (!models.length) throw new Error("Codex returned no available models.");
        return {
          models: models.map(({ isDefault: _default, ...model }) => model),
          defaultModel: (models.find((model) => model.isDefault) ?? models[0])!.id,
        };
      }
      if (result.nextCursor === cursor) throw new Error("Codex repeated its model catalog cursor.");
      cursor = result.nextCursor;
    }
    throw new Error("Codex model catalog exceeded its page limit.");
  }
  async account(): Promise<unknown> {
    return this.rpc.call("account/read", { refreshToken: false });
  }
  async create(params: Record<string, unknown>): Promise<string> {
    if (this.sessionId) throw new Error("A session already owns this connection.");
    const raw = await this.rpc.call("thread/start", params);
    if (this.options.verifyControls) {
      this.checkThreadControls(raw);
      if (
        typeof params.model === "string" &&
        z.object({ model: z.string() }).parse(raw).model !== params.model
      )
        throw new Error("Codex returned a different model than the one requested.");
    }
    const result = z.object({ thread: z.object({ id }) }).parse(raw);
    this.sessionId = result.thread.id;
    this.options.event({ type: "lifecycle", sessionId: this.sessionId, turnId: null });
    return this.sessionId;
  }
  async resume(threadId: string): Promise<void> {
    if (this.sessionId) throw new Error("A session already owns this connection.");
    const raw = await this.rpc.call("thread/resume", { threadId, excludeTurns: true });
    if (this.options.verifyControls) this.checkThreadControls(raw);
    const result = z.object({ thread: z.object({ id }) }).parse(raw);
    if (result.thread.id !== threadId) throw new Error("Resume returned a different thread.");
    this.sessionId = threadId;
    this.options.event({ type: "lifecycle", sessionId: threadId, turnId: null });
  }
  async prompt(text: string, model?: string): Promise<void> {
    if (!this.sessionId || this.prompting || this.error)
      throw new Error("Codex session is not ready.");
    this.prompting = true;
    this.turnId = undefined;
    const done = new Promise<void>((resolve, reject) => {
      this.finished = { resolve, reject };
    });
    // Attach immediately: a process may die before turn/start resolves.
    void done.catch(() => {});
    try {
      const result = z.object({ turn: z.object({ id }) }).parse(
        await this.rpc.call("turn/start", {
          threadId: this.sessionId,
          ...(model ? { model } : {}),
          input: [{ type: "text", text }],
        }),
      );
      if (this.turnId && this.turnId !== result.turn.id)
        throw new Error("Codex turn identity changed.");
      this.turnId = result.turn.id;
      this.options.event({ type: "lifecycle", sessionId: this.sessionId, turnId: this.turnId });
      await done;
    } finally {
      this.prompting = false;
      this.finished = undefined;
    }
  }
  private notification(message: RpcMessage): void {
    const params = object.parse(message.params ?? {});
    if (params.threadId !== this.sessionId || !this.prompting) return;
    if (message.method === "turn/started") {
      const turn = z.object({ id }).parse(params.turn);
      if (this.turnId && this.turnId !== turn.id) throw new Error("Concurrent turn");
      this.turnId = turn.id;
      return;
    }
    if (params.turnId !== undefined && params.turnId !== this.turnId) return;
    if (
      message.method === "item/agentMessage/delta" ||
      message.method === "item/reasoning/summaryTextDelta"
    ) {
      const text = z
        .string()
        .max(1024 * 1024)
        .parse(params.delta);
      this.options.event({
        type: message.method === "item/agentMessage/delta" ? "text" : "reasoning",
        text,
      });
    } else if (message.method === "item/started" || message.method === "item/completed") {
      const item = z.object({ id, type: z.string() }).passthrough().parse(params.item);
      const completed = message.method === "item/completed";
      const seen = completed ? this.completedItems : this.startedItems;
      if (seen.has(item.id)) return;
      if (seen.size >= 10_000) throw new Error("Item limit exceeded");
      seen.add(item.id);
      if (["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall"].includes(item.type))
        this.options.event({
          type: "tool",
          id: item.id,
          status: completed ? "completed" : "started",
          detail: item,
        });
    } else if (message.method === "turn/diff/updated")
      this.options.event({ type: "diff", detail: params });
    else if (message.method === "thread/tokenUsage/updated")
      this.options.event({ type: "usage", detail: params });
    else if (message.method === "turn/completed") {
      const turn = z
        .object({ id, status: z.enum(["completed", "interrupted", "failed"]) })
        .parse(params.turn);
      if (turn.id !== this.turnId) throw new Error("Foreign completion");
      if (turn.status === "completed") this.finished?.resolve();
      else this.fail(new Error(`Codex turn ${turn.status}.`));
    } else if (message.method === "error") this.fail(new Error(harnessError(params.error)));
  }
  private fail(error: Error): void {
    this.error = error;
    this.finished?.reject(error);
  }
  async cancel(): Promise<void> {
    try {
      if (this.sessionId && this.turnId) {
        const timer = setTimeout(
          () => this.rpc.close(new Error("Codex interruption deadline exceeded.")),
          250,
        );
        try {
          await this.rpc.call("turn/interrupt", { threadId: this.sessionId, turnId: this.turnId });
        } finally {
          clearTimeout(timer);
        }
      }
    } finally {
      await this.close();
    }
  }
  async close(gracefully = false): Promise<void> {
    if (gracefully) await this.rpc.closeGracefully();
    else {
      this.rpc.close();
      await this.rpc.exited;
    }
  }
}

export class AcpSession {
  private canLoad = false;
  private modelOption?: {
    id: string;
    currentValue: string;
    values: string[];
    names: Record<string, string>;
  };
  private readonly rpc: StdioRpc;
  private sessionId?: string;
  private prompting = false;
  constructor(private readonly options: SessionOptions) {
    this.rpc = new StdioRpc({
      ...options,
      interrupt: async () => {
        if (this.sessionId) {
          this.rpc.notify("session/cancel", { sessionId: this.sessionId });
          await new Promise<void>((resolve) => setTimeout(resolve, 25));
        }
      },
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(120_000)])
        : AbortSignal.timeout(120_000),
      notification: (message) => {
        if (message.method !== "session/update") return;
        const params = z.object({ sessionId: id, update: object }).parse(message.params);
        if (params.sessionId !== this.sessionId || !this.prompting) return;
        const update = params.update;
        if (["agent_message_chunk", "agent_thought_chunk"].includes(String(update.sessionUpdate))) {
          const content = z
            .object({ type: z.literal("text"), text: z.string().max(1024 * 1024) })
            .parse(update.content);
          options.event({
            type: update.sessionUpdate === "agent_message_chunk" ? "text" : "reasoning",
            text: content.text,
          });
        } else if (["tool_call", "tool_call_update"].includes(String(update.sessionUpdate))) {
          const tool = z
            .object({
              toolCallId: id,
              status: z.enum(["pending", "in_progress", "completed", "failed"]).optional(),
            })
            .parse(update);
          options.event({
            type: "tool",
            id: tool.toolCallId,
            status: ["completed", "failed"].includes(tool.status ?? "") ? "completed" : "started",
            detail: update,
          });
        }
      },
      request: async (message) => {
        const raw = object.parse(message.params);
        if (raw.sessionId !== this.sessionId || !this.prompting)
          throw new Error("Foreign client request");
        if (message.method !== "session/request_permission") {
          if (!options.clientRequest || !message.method)
            throw new Error("Unadvertised client capability");
          return options.clientRequest(message.method, raw);
        }
        const params = z
          .object({
            sessionId: id,
            toolCall: object,
            options: z.array(z.object({ optionId: id, kind: z.string() })).max(20),
          })
          .parse(raw);
        const kind =
          params.toolCall.kind === "execute"
            ? "command"
            : ["edit", "delete", "move"].includes(String(params.toolCall.kind))
              ? "file"
              : null;
        const once = params.options.find((option) => option.kind === "allow_once");
        if (
          kind &&
          once &&
          options.permission &&
          (await options.permission(kind, params.toolCall)) &&
          !options.signal?.aborted
        )
          return { outcome: { outcome: "selected", optionId: once.optionId } };
        return { outcome: { outcome: "cancelled" } };
      },
    });
  }
  async initialize(): Promise<{ name: string; version: string }> {
    const result = z
      .object({
        protocolVersion: z.literal(1),
        agentCapabilities: object,
        agentInfo: z.object({ name: z.string().max(200), version: z.string().max(100) }),
        authMethods: z.array(object).max(50),
      })
      .parse(
        await this.rpc.call("initialize", {
          protocolVersion: 1,
          clientInfo: { name: "vektor", version: "0.1.0" },
          clientCapabilities: this.options.clientRequest
            ? { fs: { readTextFile: true, writeTextFile: true }, terminal: true }
            : {},
        }),
      );
    this.canLoad = result.agentCapabilities.loadSession === true;
    return result.agentInfo;
  }
  async create(cwd: string, mcpServers: unknown[] = []): Promise<string> {
    if (this.sessionId) throw new Error("A session already owns this connection.");
    const result = z
      .object({ sessionId: id, configOptions: z.array(z.record(z.unknown())).optional() })
      .parse(await this.rpc.call("session/new", { cwd, mcpServers }));
    this.readModelOption(result.configOptions);
    this.sessionId = result.sessionId;
    this.options.event({ type: "lifecycle", sessionId: this.sessionId, turnId: null });
    return this.sessionId;
  }
  async resume(sessionId: string, cwd: string, mcpServers: unknown[] = []): Promise<void> {
    if (this.sessionId || !this.canLoad)
      throw new Error("This ACP agent cannot resume this session.");
    const result = z
      .object({ configOptions: z.array(z.record(z.unknown())).optional() })
      .passthrough()
      .parse(await this.rpc.call("session/load", { sessionId, cwd, mcpServers }));
    this.readModelOption(result.configOptions);
    this.sessionId = sessionId;
    this.options.event({ type: "lifecycle", sessionId, turnId: null });
  }
  private readModelOption(options?: Record<string, unknown>[]): void {
    const option = options?.find((option) => option.category === "model");
    if (!option) {
      this.modelOption = undefined;
      return;
    }
    const parsed = z
      .object({
        id: z.string(),
        currentValue: z.string(),
        options: z.array(z.object({ value: z.string(), name: z.string().optional() })),
      })
      .safeParse(option);
    if (parsed.success)
      this.modelOption = {
        id: parsed.data.id,
        currentValue: parsed.data.currentValue,
        values: parsed.data.options.map((entry) => entry.value),
        names: Object.fromEntries(
          parsed.data.options.map((entry) => [entry.value, entry.name ?? entry.value]),
        ),
      };
  }
  models(): { models: ModelInfo[]; defaultModel: string } {
    if (!this.modelOption?.values.length)
      return {
        models: [{ id: "agent-default", name: "Agent default" }],
        defaultModel: "agent-default",
      };
    return {
      models: this.modelOption.values.map((value) => ({
        id: value,
        name: this.modelOption!.names[value] ?? value,
      })),
      defaultModel: this.modelOption.currentValue,
    };
  }
  async selectModel(model: string): Promise<string> {
    if (model === "agent-default") return this.modelOption?.currentValue ?? "agent-default";
    if (!this.sessionId || !this.modelOption || !this.modelOption.values.includes(model))
      throw new Error(
        "This agent does not advertise the requested model. Select agent-default or an advertised model.",
      );
    const result = z.object({ configOptions: z.array(z.record(z.unknown())) }).parse(
      await this.rpc.call("session/set_config_option", {
        sessionId: this.sessionId,
        configId: this.modelOption.id,
        value: model,
      }),
    );
    this.readModelOption(result.configOptions);
    if (this.modelOption?.currentValue !== model)
      throw new Error("Agent model selection could not be verified.");
    return model;
  }
  async prompt(text: string): Promise<void> {
    if (!this.sessionId || this.prompting) throw new Error("ACP session is not ready.");
    this.prompting = true;
    try {
      const result = z.object({ stopReason: z.string() }).parse(
        await this.rpc.call(
          "session/prompt",
          {
            sessionId: this.sessionId,
            prompt: [{ type: "text", text }],
          },
          120_000,
        ),
      );
      if (result.stopReason !== "end_turn")
        throw new Error(`ACP turn stopped: ${result.stopReason}`);
    } finally {
      this.prompting = false;
    }
  }
  async cancel(): Promise<void> {
    try {
      if (this.sessionId) this.rpc.notify("session/cancel", { sessionId: this.sessionId });
    } finally {
      await this.close();
    }
  }
  async close(gracefully = false): Promise<void> {
    if (gracefully) await this.rpc.closeGracefully();
    else {
      this.rpc.close();
      await this.rpc.exited;
    }
  }
}
