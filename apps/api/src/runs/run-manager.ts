import {
  appendAudit,
  appendRunEvent,
  closeRunTools,
  createApproval,
  createMessage,
  createToolCall,
  getApproval,
  getProfile,
  getSetting,
  listToolCalls,
  resolveApproval,
  setSetting,
  updateRun,
  updateToolCall,
  type ProfileRecord,
  type RunRecord,
  type VektorDatabase,
} from "@vektor/db";
import { terminalInputSchema, type RunEvent, type RunUsage } from "@vektor/shared";
import type { ChatMessage, ChatProvider, ProviderEvent } from "../providers/types.js";
import { runtimeSystemPrompt, terminalEnabled, toolsForProfile } from "../runtime/policy.js";
import { RuntimeError, type TerminalExecutor } from "../runtime/terminal.js";
import { countMessageTokens, countTokens } from "../runtime/tokens.js";

type RunEventInput = RunEvent extends infer E
  ? E extends RunEvent
    ? Omit<E, "seq" | "runId">
    : never
  : never;
interface Logger {
  info: (fields: Record<string, unknown>, message: string) => void;
  error: (fields: Record<string, unknown>, message: string) => void;
}
interface ActiveRun {
  run: RunRecord;
  profile: ProfileRecord;
  controller: AbortController;
  seq: number;
  events: RunEvent[];
  listeners: Set<(event: RunEvent) => void>;
  finished: boolean;
  text: string;
  pendingText: string;
  usage: RunUsage | null;
  timer?: NodeJS.Timeout;
}
export interface RunSubscription {
  active: boolean;
  replay: RunEvent[];
  unsubscribe: () => void;
}
export interface StartRunInput {
  run: RunRecord;
  profile: ProfileRecord;
  messages: ChatMessage[];
}
export interface RunManagerOptions {
  db: VektorDatabase;
  getChatProvider: () => ChatProvider;
  logger: Logger;
  terminal: TerminalExecutor;
  redact: (text: string, partial?: boolean) => string;
  redactionHoldback?: () => number;
  runTimeoutMs?: number;
  now?: () => number;
}

export class RunManager {
  private readonly active = new Map<string, ActiveRun>();
  private readonly completionListeners = new Set<() => void>();
  private readonly pending = new Map<
    string,
    { runId: string; resolve: (approved: boolean) => void }
  >();
  constructor(private readonly options: RunManagerOptions) {}
  onFinished(listener: () => void): () => void {
    this.completionListeners.add(listener);
    return () => {
      this.completionListeners.delete(listener);
    };
  }
  get stopped(): boolean {
    return getSetting(this.options.db, "runtime.emergencyStopped") === true;
  }
  assertCanStart(): void {
    if (this.stopped)
      throw new RuntimeError(
        "Emergency stop is active. Resume execution before starting another run.",
        423,
      );
  }

  start(input: StartRunInput): void {
    this.assertCanStart();
    const active: ActiveRun = {
      run: input.run,
      profile: input.profile,
      controller: new AbortController(),
      seq: 0,
      events: [],
      listeners: new Set(),
      finished: false,
      text: "",
      pendingText: "",
      usage: null,
    };
    this.active.set(input.run.id, active);
    active.timer = setTimeout(() => {
      active.controller.abort();
      this.finalize(active, "failed", "Run exceeded its execution deadline.");
    }, this.options.runTimeoutMs ?? 120_000);
    appendAudit(this.options.db, "run.started", input.run.id, {
      profileId: input.profile.id,
      terminalMode: input.profile.terminalMode,
    });
    void this.execute(active, input.messages).catch((error) => {
      if (!active.finished)
        this.finalize(
          active,
          "failed",
          this.options.redact(error instanceof Error ? error.message : "Run failed."),
        );
    });
  }

  subscribe(runId: string, after: number, listener?: (event: RunEvent) => void): RunSubscription {
    const active = this.active.get(runId);
    if (!active) return { active: false, replay: [], unsubscribe: () => {} };
    if (listener) active.listeners.add(listener);
    return {
      active: true,
      replay: active.events.filter((event) => event.seq > after),
      unsubscribe: () => {
        if (listener) active.listeners.delete(listener);
      },
    };
  }
  isActive(runId: string): boolean {
    return this.active.has(runId);
  }
  cancel(runId: string, reason = "user"): boolean {
    const active = this.active.get(runId);
    if (!active || active.finished) return false;
    active.controller.abort();
    this.finalize(active, "cancelled", undefined, reason);
    return true;
  }
  cancelAll(reason = "shutdown"): void {
    for (const runId of [...this.active.keys()]) this.cancel(runId, reason);
  }
  async emergencyStop(): Promise<void> {
    setSetting(
      this.options.db,
      "runtime.stopVersion",
      Number(getSetting(this.options.db, "runtime.stopVersion") ?? 0) + 1,
    );
    setSetting(this.options.db, "runtime.emergencyStopped", true);
    appendAudit(this.options.db, "runtime.emergency_stop", null);
    this.cancelAll("emergency_stop");
    await this.options.terminal.stopAll();
  }
  resume(): void {
    if (this.stopped)
      setSetting(this.options.db, "runtime.resumedAt", this.options.now?.() ?? Date.now());
    setSetting(this.options.db, "runtime.emergencyStopped", false);
    appendAudit(this.options.db, "runtime.resumed", null);
  }
  async shutdown(): Promise<void> {
    this.cancelAll();
    await this.options.terminal.stopAll();
  }

  decideApproval(id: string, approved: boolean): void {
    const pending = this.pending.get(id);
    const record = getApproval(this.options.db, id);
    if (!record) throw new RuntimeError("Approval not found.", 404);
    if (!pending || record.status !== "pending" || !this.isActive(record.runId))
      throw new RuntimeError("This approval is no longer pending.", 409);
    if (this.stopped) throw new RuntimeError("Emergency stop is active.", 423);
    if (!resolveApproval(this.options.db, id, approved ? "approved" : "denied"))
      throw new RuntimeError("This approval was already resolved.", 409);
    this.pending.delete(id);
    appendAudit(this.options.db, approved ? "approval.approved" : "approval.denied", record.runId, {
      approvalId: id,
      toolCallId: record.toolCallId,
    });
    pending.resolve(approved);
  }

  private emit(active: ActiveRun, event: RunEventInput): void {
    if (active.finished) return;
    const fullEvent = { ...event, seq: ++active.seq, runId: active.run.id } as RunEvent;
    appendRunEvent(this.options.db, {
      runId: active.run.id,
      seq: fullEvent.seq,
      type: fullEvent.type,
      payloadJson: JSON.stringify(fullEvent),
    });
    active.events.push(fullEvent);
    for (const listener of active.listeners) listener(fullEvent);
  }

  private finalize(
    active: ActiveRun,
    status: "completed" | "failed" | "cancelled",
    error?: string,
    reason = "user",
  ): void {
    if (active.finished) return;
    const { db, redact } = this.options;
    active.controller.abort();
    clearTimeout(active.timer);
    if (active.pendingText) {
      const text = redact(active.pendingText);
      active.pendingText = "";
      active.text += text;
      this.emit(active, { type: "message.delta", text });
    }
    for (const [id, pending] of this.pending) {
      if (pending.runId === active.run.id) {
        this.pending.delete(id);
        pending.resolve(false);
      }
    }
    for (const tool of listToolCalls(db, active.run.id).filter((tool) =>
      ["requested", "waiting", "running"].includes(tool.status),
    )) {
      this.emit(active, {
        type: "tool.output",
        toolCallId: tool.id,
        output: error ?? `Run ${status}.`,
        isError: true,
      });
      appendAudit(db, "tool.cancelled", active.run.id, { toolCallId: tool.id, reason: status });
    }
    closeRunTools(db, active.run.id, error ?? `Run ${status}.`);
    const message = createMessage(db, {
      channelId: active.run.channelId,
      role: "assistant",
      content: redact(active.text),
      status: status === "completed" ? "complete" : status,
      runId: active.run.id,
    });
    updateRun(db, active.run.id, {
      status,
      error: error ?? null,
      usage: active.usage,
      endedAt: Date.now(),
    });
    if (status === "completed") this.emit(active, { type: "run.completed", messageId: message.id });
    else if (status === "cancelled") this.emit(active, { type: "run.cancelled", reason });
    else
      this.emit(active, {
        type: "run.failed",
        error: error ?? "Run failed.",
        code: "runtime_error",
      });
    appendAudit(db, `run.${status}`, active.run.id, {
      ...(error ? { error } : {}),
      ...(status === "cancelled" ? { reason } : {}),
    });
    active.finished = true;
    active.listeners.clear();
    this.active.delete(active.run.id);
    for (const listener of this.completionListeners) {
      try {
        listener();
      } catch (error) {
        this.options.logger.error({ err: error }, "run completion listener failed");
      }
    }
  }

  private hasPermission(active: ActiveRun): boolean {
    const current = getProfile(this.options.db, active.profile.id);
    return (
      !!current &&
      current.archivedAt === null &&
      current.terminalMode === active.profile.terminalMode &&
      terminalEnabled(current) &&
      terminalEnabled(active.profile)
    );
  }

  private async tool(
    active: ActiveRun,
    call: Extract<ProviderEvent, { type: "tool_call" }>,
  ): Promise<string> {
    const { db, terminal, redact } = this.options;
    let input: unknown;
    try {
      input = JSON.parse(call.argumentsJson);
    } catch {
      input = null;
    }
    const record = createToolCall(db, {
      runId: active.run.id,
      providerCallId: redact(call.id),
      name: redact(call.name),
      input: JSON.parse(redact(JSON.stringify(input))),
    });
    this.emit(active, {
      type: "tool.requested",
      toolCallId: record.id,
      name: record.name,
      input: JSON.parse(record.inputJson),
    });
    appendAudit(db, "tool.requested", active.run.id, {
      toolCallId: record.id,
      name: record.name,
      input: JSON.parse(record.inputJson),
    });
    try {
      if (call.name !== "terminal" || !this.hasPermission(active))
        throw new RuntimeError("This tool is disabled by the profile's terminal permissions.", 403);
      if (redact(call.argumentsJson) !== call.argumentsJson)
        throw new RuntimeError("Commands containing known credentials cannot be executed.", 403);
      const parsed = terminalInputSchema.parse(input);
      if (active.profile.terminalMode === "full-access") {
        updateToolCall(db, record.id, "waiting");
        const approval = createApproval(db, active.run.id, record.id, JSON.stringify(parsed));
        const approved = await new Promise<boolean>((resolve) => {
          this.pending.set(approval.id, { runId: active.run.id, resolve });
          this.emit(active, {
            type: "approval.requested",
            approvalId: approval.id,
            toolCallId: record.id,
            command: approval.command,
          });
          appendAudit(db, "approval.requested", active.run.id, {
            approvalId: approval.id,
            toolCallId: record.id,
          });
        });
        if (active.finished) return "Command cancelled.";
        if (!approved) throw new RuntimeError("The user denied this command.", 403);
      }
      const command = await terminal.prepare(active.profile.terminalMode, parsed);
      if (active.finished || active.controller.signal.aborted) return "Command cancelled.";
      if (!this.hasPermission(active))
        throw new RuntimeError(
          "Terminal permissions changed. Start a new run to use the updated profile.",
          403,
        );
      updateToolCall(db, record.id, "running");
      appendAudit(db, "tool.started", active.run.id, { toolCallId: record.id, command: parsed });
      const result = await terminal.execute(command, active.controller.signal);
      if (active.finished) return result.output;
      const output = JSON.stringify(result);
      updateToolCall(db, record.id, result.isError ? "failed" : "completed", output);
      this.emit(active, {
        type: "tool.output",
        toolCallId: record.id,
        output,
        isError: result.isError,
      });
      appendAudit(db, "tool.finished", active.run.id, {
        toolCallId: record.id,
        exitCode: result.exitCode,
        reason: result.reason,
      });
      return output;
    } catch (error) {
      if (active.finished) return "Command cancelled.";
      const output = redact(error instanceof Error ? error.message : "Tool execution failed.");
      const denied = error instanceof RuntimeError && error.statusCode === 403;
      updateToolCall(db, record.id, denied ? "denied" : "failed", output);
      this.emit(active, { type: "tool.output", toolCallId: record.id, output, isError: true });
      appendAudit(db, denied ? "tool.denied" : "tool.failed", active.run.id, {
        toolCallId: record.id,
        error: output,
      });
      return output;
    }
  }

  private async execute(active: ActiveRun, messages: ChatMessage[]): Promise<void> {
    const systemPrompt = runtimeSystemPrompt(active.profile);
    const history: ChatMessage[] = systemPrompt
      ? [{ role: "system", content: systemPrompt }, ...messages]
      : [...messages];
    const tools = toolsForProfile(active.profile);
    this.emit(active, {
      type: "run.started",
      conversationId: active.run.channelId,
      profileId: active.run.profileId,
      runner: "native",
    });
    for (let round = 0; round < 8; round++) {
      if (active.finished) return;
      const budget =
        (active.run.context as { availableInputTokens?: number } | null)?.availableInputTokens ??
        6144;
      const inputTokens =
        history.reduce((sum, message) => sum + countMessageTokens(message), 0) +
        (tools.length ? countTokens(JSON.stringify(tools)) + 6 : 0);
      if (inputTokens > budget)
        throw new RuntimeError(
          "Tool results exceed this run's context budget. Exclude files or use a larger model before retrying.",
        );
      const remaining = active.profile.maxTokens - (active.usage?.completionTokens ?? 0);
      if (remaining <= 0) throw new RuntimeError("Run reached its output token allowance.");
      const calls: Array<Extract<ProviderEvent, { type: "tool_call" }>> = [];
      let roundText = "";
      let pendingText = "";
      const flushText = (final = false) => {
        const cleaned = this.options.redact(pendingText, final);
        const length = final
          ? cleaned.length
          : Math.max(0, cleaned.length - (this.options.redactionHoldback?.() ?? 128));
        const delta = cleaned.slice(0, length);
        pendingText = cleaned.slice(length);
        active.pendingText = pendingText;
        if (delta) {
          active.text += delta;
          this.emit(active, { type: "message.delta", text: delta });
        }
      };
      let finish: string | undefined;
      let roundUsage: RunUsage | null = null;
      for await (const event of this.options.getChatProvider().streamChat({
        model: active.run.model,
        messages: history,
        tools,
        signal: active.controller.signal,
        maxTokens: remaining,
        temperature: active.profile.temperature,
      })) {
        if (active.finished) return;
        if (event.type === "text.delta") {
          if (active.text.length + pendingText.length + event.text.length > 500_000)
            throw new RuntimeError("Run reached its text output limit.");
          roundText += event.text;
          pendingText += event.text;
          flushText();
        } else if (event.type === "tool_call") {
          if (
            calls.length >= 8 ||
            event.argumentsJson.length > 16_000 ||
            event.id.length > 200 ||
            event.name.length > 100 ||
            calls.some((call) => call.id === event.id)
          )
            throw new RuntimeError(
              "Provider tool calls exceed the supported limits or contain duplicate IDs.",
            );
          calls.push(event);
        } else if (event.type === "error")
          throw new RuntimeError(this.options.redact(event.message));
        else if (event.type === "finish") finish = event.reason;
        else if (event.type === "usage")
          roundUsage = {
            promptTokens: event.promptTokens,
            completionTokens: event.completionTokens,
            totalTokens: event.totalTokens,
            ...(event.costUsd !== undefined ? { costUsd: event.costUsd } : {}),
          };
      }
      if (active.finished) return;
      flushText(true);
      if (roundUsage) {
        const old = active.usage;
        active.usage = {
          promptTokens: (old?.promptTokens ?? 0) + roundUsage.promptTokens,
          completionTokens: (old?.completionTokens ?? 0) + roundUsage.completionTokens,
          totalTokens: (old?.totalTokens ?? 0) + roundUsage.totalTokens,
          ...(old?.costUsd !== undefined || roundUsage.costUsd !== undefined
            ? { costUsd: (old?.costUsd ?? 0) + (roundUsage.costUsd ?? 0) }
            : {}),
        };
        this.emit(active, { type: "usage", ...active.usage });
      }
      if (finish === "error" || !finish)
        throw new RuntimeError("Provider stream ended without a successful finish.");
      if (!calls.length) {
        if (finish === "tool_calls")
          throw new RuntimeError("Provider requested tools without supplying any calls.");
        this.finalize(active, "completed");
        return;
      }
      if (finish !== "tool_calls")
        throw new RuntimeError(
          "Provider returned tool calls without a tool-call finish; no command was executed.",
        );
      history.push({
        role: "assistant",
        content: roundText,
        tool_calls: calls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.argumentsJson },
        })),
      });
      for (const call of calls) {
        const output = await this.tool(active, call);
        if (active.finished) return;
        history.push({ role: "tool", tool_call_id: call.id, content: output });
      }
    }
    throw new RuntimeError("Run reached the eight-step tool-loop limit.");
  }
}
